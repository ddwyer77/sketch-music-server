import 'dotenv/config';
import { db, FieldValue } from './firebaseAdmin.js';
import { updateCampaignMetrics, linkTikTokAccount, getUserById } from './helper.js';
import { payCreator, calculatePendingCampaignPayments, recordDeposit } from './payments.js';
import { updateActiveCampaigns } from './discordCampaignManager.js';
import { 
    client, 
    loginClient, 
    commandsList,
    handleSubmitCommand,
    handleCampaignsCommand,
    handleLoginCommand,
    handleLogoutCommand,
    handleStatusCommand,
    handleCommandsCommand,
    handleLinkCommand,
    handleCampaignAutocomplete,
    isRateLimited
} from './commands.js';
import { TOKEN_EXPIRY, RATE_LIMIT_WINDOW, MAX_REQUESTS, RATE_LIMIT } from './constants.js';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { REST, Routes } from 'discord.js';

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
    // Basic health check - just check if the server is running
    // Don't depend on Discord bot being ready
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        discordBotReady: client.isReady(),
        uptime: process.uptime()
    });
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
        // Handle case where req.body is undefined
        const campaignIds = req.body?.campaignIds;
        const result = await updateCampaignMetrics(campaignIds || null);
        res.status(200).json(result);
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

// Pay Creators 
app.post('/pay-creators', async (req, res) => {
    try {
        const { userIds, campaignId, actorId } = req.body;
        
        if (!userIds || !Array.isArray(userIds)) {
            return res.status(400).json({ error: 'userIds must be an array' });
        }
        
        if (!campaignId) {
            return res.status(400).json({ error: 'campaignId is required' });
        }

        if (!actorId) {
            return res.status(400).json({ error: 'actorId is required' });
        }

        // Fetch actor user data
        const actorUser = await getUserById(actorId);
        if (!actorUser) {
            return res.status(404).json({ error: 'Actor user not found' });
        }

        // Fetch users from DB
        const users = await Promise.all(userIds.map(getUserById));
        const validUsers = users.filter(u => u && u.paymentEmail);

        if (validUsers.length === 0) {
            return res.status(400).json({ error: 'One or more users has not added an email address for payment.' });
        }

        const campaignDoc = await db.collection('campaigns').doc(campaignId).get();
        if (!campaignDoc.exists) {
            return res.status(404).json({ error: 'Campaign not found' });
        }

        const campaign = campaignDoc.data();
        if (!campaign.videos || campaign.videos.length === 0) {
            return res.status(400).json({ error: 'There are no videos submitted for this campaign' });
        }
        
        const payments = await calculatePendingCampaignPayments(campaign, userIds);
        const result = await payCreator(payments, campaignDoc.id, {
            actorId,
            actorName: `${actorUser.firstName || ''} ${actorUser.lastName || ''}`.trim() || 'Unknown User'
        });
        
        if (!result.success) {
            return res.status(500).json({ 
                success: false,
                message: 'Failed to process payments',
                details: result.error || 'Unknown error'
            });
        }
        
        res.status(200).json({ 
            success: true, 
            message: 'All payments processed successfully',
            processedPayments: result.processedPayments
        });
    } catch (error) {
        console.error('Error processing payments:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to process payments',
            details: error.message 
        });
    }
});

// Record Deposit
app.post('/record-deposit', async (req, res) => {
    try {
        const { actorId, campaignId, amount, paymentMethod = "paypal", paymentReference = null } = req.body;
        
        if (!actorId) {
            return res.status(400).json({ error: 'actorId is required' });
        }
        
        if (!campaignId) {
            return res.status(400).json({ error: 'campaignId is required' });
        }

        if (!amount || amount <= 0) {
            return res.status(400).json({ error: 'amount must be a positive number' });
        }

        // Fetch actor user data
        const actorUser = await getUserById(actorId);
        if (!actorUser) {
            return res.status(404).json({ error: 'Actor user not found' });
        }

        const actorName = `${actorUser.firstName || ''} ${actorUser.lastName || ''}`.trim() || 'Unknown User';
        
        const result = await recordDeposit(actorId, actorName, campaignId, amount, paymentMethod, paymentReference);
        
        if (!result.success) {
            return res.status(500).json({ 
                success: false,
                message: 'Failed to record deposit',
                details: result.error || 'Unknown error'
            });
        }
        
        res.status(200).json({ 
            success: true, 
            message: 'Deposit recorded successfully',
            transactionId: result.transactionId
        });
    } catch (error) {
        console.error('Error recording deposit:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to record deposit',
            details: error.message 
        });
    }
});

// Schedule metrics update every hour
cron.schedule('0 * * * *', async () => {
    console.log('Running scheduled campaign metrics update...');
    try {
        // Update all campaign metrics
        await updateCampaignMetrics();
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

// Schedule token cleanup every 30 minutes
cron.schedule('*/30 * * * *', cleanupExpiredTokens);

// Register slash commands when the bot starts
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
    }
});

// Handle interactions
client.on('interactionCreate', async interaction => {
    try {
        // Handle autocomplete
        if (interaction.isAutocomplete()) {
            const focusedOption = interaction.options.getFocused(true);
            if (interaction.commandName === 'submit' && focusedOption.name === 'campaign_id') {
                await handleCampaignAutocomplete(interaction);
            }
            return;
        }

        if (!interaction.isCommand()) return;

        const discordId = interaction.user.id;
        
        if (isRateLimited(discordId)) {
            return interaction.reply({ 
                content: 'Please wait a moment before trying again.', 
                flags: MessageFlags.Ephemeral
            });
        }

        // Route commands to their handlers
        switch (interaction.commandName) {
            case 'submit':
                await handleSubmitCommand(interaction);
                break;
            case 'campaigns':
                await handleCampaignsCommand(interaction);
                break;
            case 'login':
                await handleLoginCommand(interaction);
                break;
            case 'logout':
                await handleLogoutCommand(interaction);
                break;
            case 'status':
                await handleStatusCommand(interaction);
                break;
            case 'commands':
                await handleCommandsCommand(interaction);
                break;
            case 'link':
                await handleLinkCommand(interaction);
                break;
            default:
                await interaction.reply({ 
                    content: 'Unknown command', 
                    flags: MessageFlags.Ephemeral 
                });
        }
    } catch (error) {
        console.error('Error handling interaction:', error);
        try {
            if (interaction.deferred) {
                await interaction.editReply({ 
                    content: 'An error occurred while processing your command. Please try again later.',
                    flags: MessageFlags.Ephemeral 
                });
            } else if (!interaction.replied) {
                await interaction.reply({ 
                    content: 'An error occurred while processing your command. Please try again later.',
                    flags: MessageFlags.Ephemeral 
                });
            }
        } catch (replyError) {
            console.error('Error sending error message:', replyError);
        }
    }
});

// Start the server first
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
    
    // Start Discord bot login asynchronously after server is running
    setTimeout(() => {
        loginClient().catch(error => {
            console.error('Failed to login Discord bot:', error);
            console.log('Server will continue running without Discord bot functionality');
        });
    }, 1000); // Wait 1 second before attempting Discord login
});
