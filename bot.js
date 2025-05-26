import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { db } from './firebaseAdmin.js';
import crypto from 'crypto';

const TOKEN_EXPIRY = 1000 * 60 * 15; // 15 minutes
const RATE_LIMIT_WINDOW = 1000 * 60; // 1 minute
const MAX_REQUESTS = 3;
const RATE_LIMIT = new Map();

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const baseUrl = process.env.BOT_LOGIN_REDIRECT_URL || 'http://localhost:3000/auth/discord-login';

// Rate limiting function
const isRateLimited = (userId) => {
    const now = Date.now();
    const userRequests = RATE_LIMIT.get(userId) || [];
    
    // Clean old requests
    const recentRequests = userRequests.filter(time => now - time < RATE_LIMIT_WINDOW);
    
    if (recentRequests.length >= MAX_REQUESTS) {
        return true;
    }
    
    recentRequests.push(now);
    RATE_LIMIT.set(userId, recentRequests);
    return false;
};

// Cleanup expired tokens
const cleanupExpiredTokens = async () => {
    try {
        const expiredTokens = await db.collection('discord_firebase_tokens')
            .where('expires_at', '<', Date.now())
            .get();
        
        const batch = db.batch();
        expiredTokens.docs.forEach(doc => {
            batch.delete(doc.ref);
        });
        await batch.commit();
    } catch (error) {
        console.error('Error cleaning up expired tokens:', error);
    }
};

// Run cleanup every hour
setInterval(cleanupExpiredTokens, 1000 * 60 * 60);

client.once('ready', () => {
    console.log(`Bot is online as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const discordId = message.author.id;

    if (isRateLimited(discordId)) {
        return message.reply('Please wait a moment before trying again.');
    }

    if (message.content === '!login') {
        try {
            // Generate token and create document
            const token = crypto.randomBytes(32).toString('hex');
            const expiresAt = Date.now() + TOKEN_EXPIRY;

            // // Create the token document
            await db.collection('discord_login_tokens').doc(token).set({
                discord_id: discordId,
                expires_at: expiresAt,
                used: false,
                created_at: Date.now()
            });


            // Generate the login URL with the token
            const link = `${baseUrl}?token=${token}`;
            return message.reply(`Click this link to link your Discord account: ${link}`);
        } catch (error) {
            console.error('Error generating login link:', error);
            console.error('Error details:', {
                code: error.code,
                message: error.message,
                stack: error.stack
            });

            if (error.code === 5) {
                console.error('NOT_FOUND error - This usually means the database or collection does not exist');
                return message.reply('Database connection error. Please contact an administrator.');
            }
            
            if (error.code === 'permission-denied') {
                return message.reply('Sorry, I don\'t have permission to perform this action. Please contact an administrator.');
            }
            return message.reply('Sorry, there was an error generating your login link. Please try again.');
        }
    }

    if (message.content.startsWith('!submit ')) {
        try {
            const url = message.content.replace('!submit ', '').trim();

            // Validate URL
            try {
                new URL(url);
            } catch {
                return message.reply('Please provide a valid URL');
            }

            // Find user by discord_id
            const userQuery = await db.collection('users')
                .where('discord_id', '==', discordId)
                .limit(1)
                .get();

            if (userQuery.empty) {
                return message.reply('Please login first using !login');
            }

            const userDoc = userQuery.docs[0];
            const currentUrls = userDoc.data().urls || [];
            
            await userDoc.ref.update({
                urls: [...currentUrls, url]
            });

            return message.reply('URL submitted successfully!');
        } catch (error) {
            console.error('Error submitting URL:', error);
            if (error.code === 'permission-denied') {
                return message.reply('Sorry, I don\'t have permission to perform this action. Please contact an administrator.');
            }
            return message.reply('Sorry, there was an error submitting your URL. Please try again.');
        }
    }
});

client.login(process.env.DISCORD_BOT_TOKEN);
