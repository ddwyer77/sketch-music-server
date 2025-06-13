import 'dotenv/config';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, MessageFlags, EmbedBuilder } from 'discord.js';
import { db, FieldValue } from './firebaseAdmin.js';
import { 
    isUserAuthenticated, 
    getFirebaseUserId, 
    sanitizeDiscordId,
    sanitizeUrl,
    sanitizeCampaignId,
    videoContainsRequiredSound,
    getTikTokVideoData,
    updateAllCampaignMetrics,
    linkTikTokAccount,
    sanitizeTikTokId
} from './helper.js';
import { updateActiveCampaigns } from './discordCampaignManager.js';
import crypto from 'crypto';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';

const app = express();
const port = process.env.PORT || 8080;

// Enable CORS for all routes
app.use(cors({
    origin: process.env.FRONTEND_BASE_URL || 'http://localhost:3000', // Allow requests from your frontend
    methods: ['GET', 'POST'], // Allow these HTTP methods
    credentials: true // Allow credentials (cookies, authorization headers, etc)
}));

// Parse JSON bodies
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
    res.status(200).send('Bot is running!');
});

app.get('/link-tiktok-account/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { firebaseUserId, token } = req.query;

        if (!firebaseUserId || !token) {
            return res.status(400).json({
                success: false,
                message: 'Firebase user ID and token are required'
            });
        }

        const result = await linkTikTokAccount(userId, token);
        
        // Return the same response structure as the function
        return res.status(result.success ? 200 : 400).json(result);

    } catch (error) {
        console.error('Error linking TikTok account:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
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

// Update active campaigns endpoint
app.post('/api/discord/update-active-campaigns', async (req, res) => {
    try {
        console.log("Starting update-active-campaigns request");
        const result = await updateActiveCampaigns(client);
        console.log("Update active campaigns result:", result);
        res.status(200).json(result);
    } catch (error) {
        console.error('Error in update-active-campaigns endpoint:', error);
        res.status(500).json({ 
            error: 'Failed to update active campaigns',
            details: error.message 
        });
    }
});

// Add API endpoint to update all campaign metrics
app.post('/api/update-metrics', async (req, res) => {
    try {
        await updateAllCampaignMetrics();
        res.status(200).json({ message: 'Metrics updated successfully' });
    } catch (error) {
        console.error('Error updating campaign metrics:', error);
        res.status(500).json({ error: 'Failed to update campaign metrics', details: error.message });
    }
});

// Generate social media account link token
app.post('/api/generate-social-media-account-link-token', async (req, res) => {
    try {
        const { firebaseUserId } = req.body;

        if (!firebaseUserId) {
            return res.status(400).json({ error: 'Firebase user ID is required' });
        }

        // Check rate limit
        const rateLimitKey = `token_gen_${firebaseUserId}`;
        const now = Date.now();
        const userRequests = RATE_LIMIT.get(rateLimitKey) || [];
        const recentRequests = userRequests.filter(time => now - time < RATE_LIMIT_WINDOW);
        
        if (recentRequests.length >= MAX_REQUESTS) {
            return res.status(429).json({ 
                error: 'Too many requests. Please try again later.',
                retryAfter: Math.ceil((RATE_LIMIT_WINDOW - (now - recentRequests[0])) / 1000)
            });
        }
        
        recentRequests.push(now);
        RATE_LIMIT.set(rateLimitKey, recentRequests);

        // Generate a user-friendly token (8 characters, alphanumeric)
        const generateToken = () => {
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
            let token = '';
            for (let i = 0; i < 8; i++) {
                token += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            return token;
        };

        // Generate new token
        const token = generateToken();
        const expires_at = Date.now() + (60 * 60 * 1000); // 1 hour from now

        // Store token in database WITH userId
        await db.collection('socialMediaAccountLinkTokens').doc(firebaseUserId).set({
            token,
            userId: firebaseUserId,
            created_at: Date.now(),
            expires_at,
            used: false
        });

        res.json({
            token,
            expires_at
        });

    } catch (error) {
        console.error('Error generating social media account link token:', error);
        res.status(500).json({ error: 'Failed to generate token', details: error.message });
    }
});

// Schedule metrics update every hour
cron.schedule('0 * * * *', async () => {
    console.log('Running scheduled campaign metrics update...');
    try {
        // Update all campaign metrics
        await updateAllCampaignMetrics();
        console.log('Scheduled metrics update completed.');

        // Only update Discord channels if the client is ready
        if (client.isReady()) {
            await updateActiveCampaigns(client);
            console.log('Discord channel updates completed.');
        } else {
            console.log('Discord client not ready, skipping channel updates');
        }
    } catch (error) {
        console.error('Scheduled update failed:', error);
    }
});

// Clean up expired social media account link tokens
const cleanupExpiredTokens = async () => {
    try {
        const now = Date.now();
        const expiredTokens = await db.collection('socialMediaAccountLinkTokens')
            .where('expires_at', '<', now)
            .get();

        const deletePromises = expiredTokens.docs.map(doc => doc.ref.delete());
        await Promise.all(deletePromises);

        console.log(`Cleaned up ${expiredTokens.size} expired social media account link tokens`);
    } catch (error) {
        console.error('Error cleaning up expired tokens:', error);
    }
};

// Schedule token cleanup every 15 minutes
cron.schedule('*/15 * * * *', cleanupExpiredTokens);

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

// Register slash commands
const commandsList = [
    new SlashCommandBuilder()
        .setName('submit')
        .setDescription('Submit a video to a campaign')
        .addStringOption(option =>
             option
                  .setName('campaign_id')
                  .setDescription('The campaign ID')
                  .setRequired(true)
                  .setAutocomplete(true)
              )
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
    new SlashCommandBuilder()
        .setName('campaigns')
        .setDescription('List current campaigns assigned to your server.'),
    new SlashCommandBuilder()
        .setName('commands')
        .setDescription('List available commands'),
    new SlashCommandBuilder()
        .setName('link')
        .setDescription('Link your TikTok account')
        .addStringOption(option =>
            option.setName('tiktok_username')
                .setDescription('Your TikTok username')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('link_token')
                .setDescription('The token generated from the website')
                .setRequired(true)),
];

client.once('ready', async () => {
    console.log(`Bot is online as ${client.user.tag}`);

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
            { body: commandsList }
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

    // AUTOCOMPLETE for campaign_id
    if (interaction.isAutocomplete()) {
        const focusedOption = interaction.options.getFocused(true);

        if (interaction.commandName === 'submit' && focusedOption.name === 'campaign_id') {
          try {
            const serverId = interaction.guildId;
            const query = focusedOption.value?.toLowerCase() || '';

            // Fetch up to 25 campaigns for this server that are not complete
            const campaignsSnapshot = await db
              .collection('campaigns')
              .where('serverIds', 'array-contains', serverId)
              .where('isComplete', '==', false)
              .limit(25)
              .get();

            const MAX_NAME_LENGTH = 100;

            const choices = campaignsSnapshot.docs
              .map(doc => {
                const data = doc.data();
                // Combine name and notes, truncate to 100 chars if needed
                let name = `${data.name || doc.id}`;
                if (name.length > MAX_NAME_LENGTH) {
                  name = name.slice(0, MAX_NAME_LENGTH - 1) + '…';
                }
                return {
                  name,
                  value: doc.id
                };
              })
              // Filter by user's current input
              .filter(choice => choice.name.toLowerCase().includes(query))
              .slice(0, 25);

            // If no campaigns are available, show a message
            if (choices.length === 0) {
                return interaction.respond([
                    { name: 'Sorry, there are currently no active campaigns', value: 'no_campaigns' }
                ]);
            }

            // Always respond (even with an empty array)
            return interaction.respond(choices);
          } catch (error) {
            console.error('Autocomplete error:', error);
            // Show a fallback if error occurs
            return interaction.respond([
              { name: 'Failed to load campaigns', value: 'error' }
            ]);
          }
        }
        return;
      }

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
            let email = null;
            let tiktokVerified = false;
            const firebaseUserId = await getFirebaseUserId(discordId);
            if (firebaseUserId) {
                const userDoc = await db.collection('users').doc(firebaseUserId).get();
                if (userDoc.exists) {
                    email = userDoc.data().email || null;
                    tiktokVerified = userDoc.data().tiktokVerified || false;
                }
            }
            let content = `**Username:** \`${interaction.user.username}\`\n**Logged In:** \`${isAuthenticated}\`\n**Server ID:** \`${interaction.guildId}\`\n**TikTok Account Verified:** \`${tiktokVerified}\``;
            if (email) {
                content += `\n**Email:** \`${email}\``;
            }
            return interaction.reply({
                content,
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

    // SUBMIT COMMAND
    if (interaction.commandName === 'submit') {
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

            // Check if TikTok account is verified
            const userDoc = await db.collection('users').doc(firebaseUserId).get();
            const userData = userDoc.data();
            
            if (!userData?.tiktokVerified) {
                const errorEmbed = new EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle('❌ TikTok Account Not Verified')
                    .setDescription('You need to verify your TikTok account before submitting videos. Use the /link command to verify your TikTok account.');
                
                return interaction.reply({
                    embeds: [errorEmbed],
                    flags: MessageFlags.Ephemeral
                });
            }

            const campaignId = sanitizeCampaignId(interaction.options.getString('campaign_id'));
            const videoUrl = sanitizeUrl(interaction.options.getString('video_url'));

            const campaignRef = db.collection('campaigns').doc(campaignId);
            const campaign = await campaignRef.get();
            const campaignData = campaign.data();

            if (!campaign.exists) {
                return interaction.reply({ 
                    content: 'Campaign not found.', 
                    flags: MessageFlags.Ephemeral
                });
            }

            // Check if campaign is complete
            if (campaignData.isComplete) {
                return interaction.reply({ 
                    content: 'Sorry, this campaign has already ended.', 
                    flags: MessageFlags.Ephemeral
                });
            }

            // Get TikTok video data
            const videoData = await getTikTokVideoData(videoUrl);

            // Check if required sound is included
            if (campaignData.requireSound && campaignData.soundId) {
                const hasRequiredSound = await videoContainsRequiredSound(videoUrl, campaignData);
                if (!hasRequiredSound) {
                    const errorEmbed = new EmbedBuilder()
                        .setColor('#FF0000')  // Red color for errors
                        .setTitle('❌ Error')
                        .setDescription(`We've detected this submission does not contain the required sound ID: ${campaignData.soundId}. Please double check your submission or contact your administrator for more information.`);
                    
                    return interaction.reply({ 
                        embeds: [errorEmbed],
                        flags: MessageFlags.Ephemeral
                    });
                }
            }

            // Check for duplicate submissions
            const existingVideos = campaignData.videos || [];
            const isDuplicate = existingVideos.some(video => video.url === videoUrl);
            
            if (isDuplicate) {
                const errorEmbed = new EmbedBuilder()
                    .setColor('#FF0000')  // Red color for errors
                    .setTitle('❌ Error')
                    .setDescription('This video has already been submitted.');
                
                return interaction.reply({
                    embeds: [errorEmbed],
                    flags: MessageFlags.Ephemeral
                });
            }

            // Check max submissions limit
            if (campaignData.maxSubmissions && campaignData.maxSubmissions !== '' && campaignData.maxSubmissions !== null) {
                const currentSubmissions = existingVideos.length;
                if (currentSubmissions >= campaignData.maxSubmissions) {
                    const errorEmbed = new EmbedBuilder()
                        .setColor('#FF0000')  // Red color for errors
                        .setTitle('❌ Error')
                        .setDescription('Sorry, this campaign has already reached the max number of submissions');
                    
                    return interaction.reply({
                        embeds: [errorEmbed],
                        flags: MessageFlags.Ephemeral
                    });
                }
            }

            const now = Date.now();
            const submissionData = {
                author_id: firebaseUserId,
                created_at: now,
                status: 'pending',
                updated_at: now,
                url: videoUrl,
                // Add TikTok video data
                id: videoData.id,
                title: videoData.title,
                author: videoData.author,
                views: videoData.views,
                shares: videoData.shares,
                comments: videoData.comments,
                likes: videoData.likes,
                description: videoData.description,
                createdAt: videoData.createdAt,
                musicTitle: videoData.musicTitle,
                musicAuthor: videoData.musicAuthor,
                musicId: videoData.musicId
            };

            await campaignRef.update({
                videos: FieldValue.arrayUnion(submissionData)
            });

            const successEmbed = new EmbedBuilder()
                .setColor('#00FF00')  // Green color for success
                .setTitle('✅ Success')
                .setDescription('Video added successfully!');

            return interaction.reply({ 
                embeds: [successEmbed],
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

            const errorEmbed = new EmbedBuilder()
                .setColor('#FF0000')  // Red color for errors
                .setTitle('❌ Error')
                .setDescription(errorMessage);
            
            return interaction.reply({ 
                embeds: [errorEmbed],
                flags: MessageFlags.Ephemeral
            });
        }
    }

    // CAMPAIGNS COMMAND
    if (interaction.commandName === 'campaigns') {
        const isAuthenticated = await isUserAuthenticated(discordId);
        if (!isAuthenticated) {
            return interaction.reply({
                content: 'Please log in to view campaigns with the /login command.',
                flags: MessageFlags.Ephemeral
            });
        }

        const serverId = interaction.guildId;
        const campaignsSnapshot = await db
            .collection('campaigns')
            .where('serverIds', 'array-contains', serverId)
            .where('isComplete', '==', false)  // Only show non-completed campaigns
            .limit(10)
            .get();

        if (campaignsSnapshot.empty) {
            return interaction.reply({
                content: 'No active campaigns found for this server. Please contact the server admin for more information.',
                flags: MessageFlags.Ephemeral
            });
        }
        
        const embeds = campaignsSnapshot.docs.map(doc => {
            const data = doc.data();
            const embed = new EmbedBuilder()
                .setTitle(data.name || 'Untitled Campaign')
                .setDescription(`**Campaign ID:** \`${doc.id}\``)
                .setImage(data.imageUrl);

            let soundSection = '';
            if (data.soundId && data.soundId.trim() !== '') {
                soundSection += `**ID:** \`${data.soundId}\`\n`;
            } else {
                soundSection += `**ID:** N/A\n`;
            }
            if (data.soundUrl && data.soundUrl.trim() !== '') {
                soundSection += `**URL:** [Listen here](${data.soundUrl})`;
            } else {
                soundSection += `**URL:** N/A`;
            }
            embed.addFields({ name: "Sound", value: soundSection });

            let notesSection = '';
            if (data.notes && data.notes.trim() !== '') {
                notesSection = data.notes;
            } else {
                notesSection = "N/A";
            }

            embed.addFields({ name: "Notes", value: notesSection });

            return embed;
        });

        const seeAllNote = `Don't see what you're looking for? To see all campaigns, [click here](${process.env.FRONTEND_BASE_URL}/campaigns?serverId=${serverId}).`;

        return interaction.reply({
            content: seeAllNote,
            embeds,
            flags: MessageFlags.Ephemeral 
        });
    }

    // Commands Command
    if (interaction.commandName === 'commands') {
        const embed = new EmbedBuilder()
            .setTitle('Available Commands')
            .setDescription('List of available bot commands and their usage.');

        for (const cmd of commandsList) {
            // Turn SlashCommandBuilder into a JSON object for easy inspection
            const { name, description, options } = cmd.toJSON();

            let argString = '';
            if (options && options.length > 0) {
                argString = options.map(opt =>
                    `• \`${opt.name}\`${opt.required ? ' (required)' : ''}: ${opt.description}`
                ).join('\n');
            }

            embed.addFields({
                name: `/${name}`,
                value: `${description}${argString ? '\n' + argString : ''}`
            });
        }

        return interaction.reply({
            embeds: [embed],
            flags: MessageFlags.Ephemeral
        });
    }

    if (interaction.commandName === 'link') {
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

            const tiktokUsername = interaction.options.getString('tiktok_username');
            const linkToken = interaction.options.getString('link_token');

            if (!tiktokUsername || !linkToken) {
                const errorEmbed = new EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle('❌ Error')
                    .setDescription('Both TikTok username and link token are required.');
                
                return interaction.reply({
                    embeds: [errorEmbed],
                    flags: MessageFlags.Ephemeral
                });
            }
            
            // First reply to acknowledge the command
            await interaction.deferReply({ ephemeral: true });

            // Link the TikTok account
            const result = await linkTikTokAccount(tiktokUsername, linkToken);
            
            const embed = new EmbedBuilder()
                .setTitle(result.success ? '✅ Success' : '❌ Error')
                .setDescription(result.message)
                .setColor(result.success ? '#00FF00' : '#FF0000');

            if (result.success) {
                embed.addFields(
                    { name: 'TikTok Username', value: result.data.uniqueId },
                    { name: 'Profile', value: result.data.title }
                );
            }

            return interaction.editReply({
                embeds: [embed],
                flags: MessageFlags.Ephemeral
            });

        } catch (error) {
            console.error('Error in link command:', error);
            const errorEmbed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ Error')
                .setDescription('Failed to link TikTok account. Please try again later.');
            
            return interaction.editReply({
                embeds: [errorEmbed],
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
