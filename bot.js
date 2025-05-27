import 'dotenv/config';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { db, FieldValue } from './firebaseAdmin.js';
import crypto from 'crypto';

const TOKEN_EXPIRY = 1000 * 60 * 15; // 15 minutes
const RATE_LIMIT_WINDOW = 1000 * 60; // 1 minute
const MAX_REQUESTS = 3;
const RATE_LIMIT = new Map();

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const baseUrl = process.env.BOT_LOGIN_REDIRECT_URL || 'http://localhost:3000/auth/discord-login';

// Helper function to get Firebase user ID from Discord ID
async function getFirebaseUserId(discordId) {
    try {
        const userDoc = await db.collection('users')
            .where('discord_id', '==', discordId)
            .limit(1)
            .get();
        
        if (userDoc.empty) {
            return null;
        }
        
        return userDoc.docs[0].id;
    } catch (error) {
        console.error('Error getting Firebase user ID:', error);
        return null;
    }
}

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

client.once('ready', async () => {
    console.log(`Bot is online as ${client.user.tag}`);
    
    // Register slash commands
    const commands = [
        new SlashCommandBuilder()
            .setName('add')
            .setDescription('Add a video to a campaign')
            .addStringOption(option =>
                option.setName('campaign_id')
                    .setDescription('The campaign ID')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('video_url')
                    .setDescription('The URL of the video to add')
                    .setRequired(true))
    ];

    try {
        if (!process.env.DISCORD_CLIENT_ID) {
            throw new Error('DISCORD_CLIENT_ID is not set in environment variables');
        }

        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
        
        // Get the first guild the bot is in
        const guilds = await client.guilds.fetch();
        const firstGuild = guilds.first();
        
        if (!firstGuild) {
            throw new Error('Bot is not in any guilds');
        }

        console.log(`Registering commands for guild: ${firstGuild.name}`);
        
        // Register commands to the specific guild
        await rest.put(
            Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, firstGuild.id),
            { body: commands }
        );
        
        console.log('Successfully registered slash commands');
    } catch (error) {
        console.error('Error registering slash commands:', error);
        console.error('Full error details:', {
            message: error.message,
            code: error.code,
            stack: error.stack
        });
        
        if (error.message.includes('DISCORD_CLIENT_ID')) {
            console.error('Please set DISCORD_CLIENT_ID in your .env file');
        }
    }
});

// Handle slash commands
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    if (interaction.commandName === 'add') {
        const discordId = interaction.user.id;
        
        if (isRateLimited(discordId)) {
            return interaction.reply({ content: 'Please wait a moment before trying again.', ephemeral: true });
        }

        const firebaseUserId = await getFirebaseUserId(discordId);
        if (!firebaseUserId) {
            return interaction.reply({ 
                content: 'You need to link your Discord account first. Use the !login command.', 
                ephemeral: true 
            });
        }

        const campaignId = interaction.options.getString('campaign_id');
        const videoUrl = interaction.options.getString('video_url');

        try {
            const campaignRef = db.collection('campaigns').doc(campaignId);
            const campaign = await campaignRef.get();

            if (!campaign.exists) {
                return interaction.reply({ 
                    content: 'Campaign not found.', 
                    ephemeral: true 
                });
            }

            const now = Date.now();
            const videoData = {
                author_id: firebaseUserId,
                created_at: now,
                status: 'pending',
                updated_at: now,
                url: videoUrl
            };

            await campaignRef.update({
                videos: FieldValue.arrayUnion(videoData)
            });

            return interaction.reply({ 
                content: 'Video added successfully!', 
                ephemeral: true 
            });
        } catch (error) {
            console.error('Error adding video:', error);
            return interaction.reply({ 
                content: 'There was an error adding your video. Please try again.', 
                ephemeral: true 
            });
        }
    }
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


        
});

client.login(process.env.DISCORD_BOT_TOKEN);
