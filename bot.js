import 'dotenv/config';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, MessageFlags } from 'discord.js';
import { db, FieldValue } from './firebaseAdmin.js';
import { 
    isUserAuthenticated, 
    getFirebaseUserId, 
    cleanupExpiredTokens,
    sanitizeDiscordId,
    sanitizeToken,
    sanitizeUrl,
    sanitizeCampaignId
} from './helper.js';
import crypto from 'crypto';
import express from 'express';
import cors from 'cors';

const app = express();
const port = process.env.PORT || 8080;

// Enable CORS for all routes
app.use(cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000', // Allow requests from your frontend
    methods: ['GET', 'POST'], // Allow these HTTP methods
    credentials: true // Allow credentials (cookies, authorization headers, etc)
}));

// Parse JSON bodies
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
    res.status(200).send('Bot is running!');
});

// Token verification endpoint
app.post('/verify-token', async (req, res) => {
    try {
        const { token, firebaseUserId } = req.body;
        
        if (!token || !firebaseUserId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Get the token document
        const tokenDoc = await db.collection('discord_login_tokens').doc(token).get();
        
        if (!tokenDoc.exists) {
            return res.status(404).json({ error: 'Token not found' });
        }

        const tokenData = tokenDoc.data();
        
        // Check if token is expired
        if (tokenData.expires_at < Date.now()) {
            await tokenDoc.ref.delete();
            return res.status(400).json({ error: 'Token has expired' });
        }

        // Update the user's document with their Discord ID
        await db.collection('users').doc(firebaseUserId).update({
            discord_id: tokenData.discord_id
        });

        // Delete the used token
        await tokenDoc.ref.delete();

        res.json({ success: true });
    } catch (error) {
        console.error('Error verifying token:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

const TOKEN_EXPIRY = 1000 * 60 * 15; // 15 minutes
const RATE_LIMIT_WINDOW = 1000 * 60; // 1 minute
const MAX_REQUESTS = 5;
const RATE_LIMIT = new Map();

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const baseUrl = process.env.BOT_LOGIN_REDIRECT_URL;

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

// Run cleanup every 5 minutes
setInterval(cleanupExpiredTokens, 1000 * 60 * 5);

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
                    .setRequired(true)),
        new SlashCommandBuilder()
            .setName('login')
            .setDescription('Get a link to authenticate your Discord account'),
        new SlashCommandBuilder()
            .setName('logout')
            .setDescription('Unlink your Discord account'),
        new SlashCommandBuilder()
            .setName('status')
            .setDescription('Check if you are logged in'),
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

    const discordId = interaction.user.id;
    
    if (isRateLimited(discordId)) {
        return interaction.reply({ content: 'Please wait a moment before trying again.', flags: MessageFlags.Ephemeral});
    }

    // LOGIN COMMAND
    if (interaction.commandName === 'login') {
        try {
            // Generate token and create document
            const token = crypto.randomBytes(32).toString('hex');
            const expiresAt = Date.now() + TOKEN_EXPIRY;

            // Create the token document
            await db.collection('discord_login_tokens').doc(token).set({
                discord_id: sanitizeDiscordId(discordId),
                username: interaction.user.username,
                expires_at: expiresAt,
                used: false,
                created_at: Date.now()
            });

            // Generate the login URL with the token
            const link = `${baseUrl}?token=${token}`;
            return interaction.reply({ 
                content: `Click this link to link your Discord account: ${link}`,
                flags: MessageFlags.Ephemeral 
            });
        } catch (error) {
            console.error('Error generating login link:', error);
            return interaction.reply({ 
                content: 'Sorry, there was an error generating your login link. Please try again.',
                flags: MessageFlags.Ephemeral 
            });
        }
    }

    // STATUS COMMAND
    if (interaction.commandName === 'status') {
        try {
            const isAuthenticated = await isUserAuthenticated(discordId);
            return interaction.reply({
                content: `**Username:** \`${interaction.user.username}\`\n**Logged In:** \`${isAuthenticated}\``,
                flags: MessageFlags.Ephemeral
            });
        } catch (error) {
            console.error('An error has occurred with the status command:', error);
            return interaction.reply({ 
                content: 'Sorry, an error has occurred while trying to retrieve your status. Please try again later.',
                flags: MessageFlags.Ephemeral 
            });
        }
    }
    
    // LOGOUT COMMAND
    if (interaction.commandName === 'logout') {
        try {
            const isAuthenticated = await isUserAuthenticated(discordId);
            if (!isAuthenticated) {
                return interaction.reply({
                    content: 'It looks like you are already logged out. Log in with /login.',
                    flags: MessageFlags.Ephemeral 
                });
            }

            // Find the user document with this Discord ID
            const userQuery = await db.collection('users')
                .where('discord_id', '==', sanitizeDiscordId(discordId))
                .limit(1)
                .get();

            if (!userQuery.empty) {
                // Remove the Discord ID from the user document
                await userQuery.docs[0].ref.update({
                    discord_id: FieldValue.delete()
                });
            }

            await interaction.reply({ content: 'You have been logged out.', flags: MessageFlags.Ephemeral});
        } catch (error) {
            console.error('Error logging out:', error);
            return interaction.reply({ 
                content: 'Sorry, an error has occurred attempting to log you out. Please try again later.',
                flags: MessageFlags.Ephemeral 
            });
        }
    }

    // ADD COMMAND
    if (interaction.commandName === 'add') {
        try {
            // Check if user is authenticated
            const isAuthenticated = await isUserAuthenticated(discordId);
            if (!isAuthenticated) {
                return interaction.reply({ 
                    content: 'You need to authenticate first. Use the /login command.', 
                    flags: MessageFlags.Ephemeral
                });
            }

            const firebaseUserId = await getFirebaseUserId(discordId);
            if (!firebaseUserId) {
                return interaction.reply({ 
                    content: 'You need to link your Discord account first. Use the /login command.', 
                    flags: MessageFlags.Ephemeral
                });
            }

            const campaignId = sanitizeCampaignId(interaction.options.getString('campaign_id'));
            const videoUrl = sanitizeUrl(interaction.options.getString('video_url'));

            const campaignRef = db.collection('campaigns').doc(campaignId);
            const campaign = await campaignRef.get();

            if (!campaign.exists) {
                return interaction.reply({ 
                    content: 'Campaign not found.', 
                    flags: MessageFlags.Ephemeral
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
                flags: MessageFlags.Ephemeral
            });
        } catch (error) {
            console.error('Error adding video:', error);
            let errorMessage = 'There was an error adding your video. ';
            if (error.message.includes('Invalid')) {
                errorMessage += error.message;
            } else {
                errorMessage += 'Please try again.';
            }
            return interaction.reply({ 
                content: errorMessage, 
                flags: MessageFlags.Ephemeral
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
});

client.login(process.env.DISCORD_BOT_TOKEN);
