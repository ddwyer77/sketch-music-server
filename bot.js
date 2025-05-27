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


        if (message.content === '!test') {
            try {
                const discordId = message.author.id;
                console.log('Test command received from Discord ID:', discordId);

                // 1. Find user by discord_id
                console.log('Searching for user with discord_id:', discordId);
                const userQuery = await db.collection('users')
                    .where('discord_id', '==', discordId)
                    .limit(1)
                    .get();

                console.log('Query results:', {
                    empty: userQuery.empty,
                    size: userQuery.size,
                    docs: userQuery.docs.map(doc => ({
                        id: doc.id,
                        data: doc.data()
                    }))
                });

                // 2. Check if user exists
                if (userQuery.empty) {
                    console.log('No user found with this Discord ID');
                    return message.reply('Please login first using !login');
                }

                // 3. Get the user document
                const userDoc = userQuery.docs[0];
                const userData = userDoc.data();
                console.log('Found user document:', {
                    id: userDoc.id,
                    data: userData
                });

                // 4. Get current groups or initialize empty array
                const currentGroups = userData.groups || [];
                console.log('Current groups:', currentGroups);

                // 5. Check if user is already in the test group
                if (currentGroups.includes('testGroup')) {
                    console.log('User already in testGroup');
                    return message.reply('You are already in the test group!');
                }

                // 6. Add to groups array
                const updatedGroups = [...currentGroups, 'testGroup'];
                console.log('Updated groups array:', updatedGroups);

                // 7. Update the user's document
                console.log('Updating user document with new groups');
                await userDoc.ref.update({
                    groups: updatedGroups
                });

                console.log('Update successful');
                return message.reply('Test Successful. Added to Group "TEST Group"');

            } catch (error) {
                console.error('Error in test command:', error);
                console.error('Error details:', {
                    code: error.code,
                    message: error.message,
                    stack: error.stack
                });
                return message.reply('Sorry, there was an error processing the test command. Please try again.');
            }
        }
});

client.login(process.env.DISCORD_BOT_TOKEN);
