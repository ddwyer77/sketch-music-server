import { isUserAdmin, sanitizeCampaignId, getFirebaseUserId, sanitizeUserId } from './helper.js';
import { db, FieldValue } from './firebaseAdmin.js';
import axios from 'axios';

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET_KEY = process.env.PAYPAL_SECRET_KEY;
const PAYPAL_API_BASE = process.env.PAYPAL_MODE === 'sandbox' ? 'https://api.sandbox.paypal.com' : 'https://api.paypal.com';

// 1. Get PayPal OAuth token
async function getPayPalAccessToken() {
    const response = await axios({
        url: `${PAYPAL_API_BASE}/v1/oauth2/token`,
        method: 'post',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        auth: {
            username: PAYPAL_CLIENT_ID,
            password: PAYPAL_SECRET_KEY,
        },
        data: 'grant_type=client_credentials',
    });
    return response.data.access_token;
}

// 2. Send simple PayPal transfer
async function sendPayPalTransfer(paymentEmail, amount, userId) {
    const accessToken = await getPayPalAccessToken();
    
    const body = {
        sender_batch_header: {
            sender_batch_id: `transfer_${Date.now()}_${userId}`,
            email_subject: 'You have a payout!',
            email_message: 'Your creator payout has been processed successfully.'
        },
        items: [{
            recipient_type: 'EMAIL',
            amount: {
                value: amount,
                currency: 'USD'
            },
            receiver: paymentEmail,
            note: 'Creator payout',
            sender_item_id: userId
        }]
    };

    const response = await axios({
        url: `${PAYPAL_API_BASE}/v1/payments/payouts`,
        method: 'post',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
        },
        data: body,
    });

    return response.data;
}

export async function payCreator(userId, { actorId, actorName }) {
    try {
        // PHASE 1: Validate and sanitize inputs
        const sanitizedUserId = sanitizeUserId(userId);
        
        // Validate actor info
        if (!actorId || !actorName) {
            throw new Error('Actor ID and name are required');
        }

        // PHASE 2: Get user data and validate
        const userDoc = await db.collection('users').doc(sanitizedUserId).get();
        if (!userDoc.exists) {
            throw new Error('User not found');
        }

        const userData = userDoc.data();
        
        // Validate user has payment email
        if (!userData.paymentEmail) {
            throw new Error('User does not have a payment email configured');
        }

        // Validate user has funds in wallet
        const walletAmount = parseFloat(userData.wallet) || 0;
        if (walletAmount <= 0) {
            throw new Error('User wallet is empty or has insufficient funds');
        }

        // PHASE 3: Create transaction record as "pending" BEFORE sending money
        const reconciliationId = `PAY-${Date.now()}-${sanitizedUserId}`;
        const transactionEntry = {
            targetUserId: sanitizedUserId,
            targetUserName: `${userData.firstName || ''} ${userData.lastName || ''}`.trim() || userData.email || 'Unknown',
            amount: -walletAmount, // Negative because it's a payment out
            type: "creatorPayout",
            source: "walletWithdrawal",
            actorId: actorId,
            actorName: actorName,
            status: "pending", // Start as pending
            currency: "USD",
            paymentMethod: "paypal",
            paymentReference: null, // Will be updated after PayPal
            createdAt: FieldValue.serverTimestamp(),
            isTestPayment: PAYPAL_API_BASE.includes('sandbox'),
            metadata: {
                paymentEmail: userData.paymentEmail,
                walletAmount: walletAmount,
                paymentStatus: "pending",
                reconciliationId: reconciliationId
            }
        };

        const transactionRef = await db.collection('transactions').add(transactionEntry);
        const transactionId = transactionRef.id;

        // PHASE 4: Send PayPal payout (the critical step)
        const payoutResult = await sendPayPalTransfer(
            userData.paymentEmail, 
            walletAmount.toFixed(2), 
            sanitizedUserId
        );

        // Verify PayPal response
        if (!payoutResult || !payoutResult.batch_header || !payoutResult.batch_header.payout_batch_id) {
            throw new Error('Invalid PayPal response');
        }

        const payoutBatchId = payoutResult.batch_header.payout_batch_id;

        // PHASE 5: Update transaction to "completed" now that money was sent
        await transactionRef.update({
            status: "completed",
            paymentReference: payoutBatchId,
            'metadata.payoutBatchId': payoutBatchId,
            'metadata.paymentStatus': "completed",
            completedAt: FieldValue.serverTimestamp()
        });

        // PHASE 6: Update user wallet to 0 (CRITICAL - only after PayPal succeeds)
        await userDoc.ref.update({
            wallet: 0,
            lastPayoutAt: FieldValue.serverTimestamp(),
            lastPayoutAmount: walletAmount,
            lastPayoutBatchId: payoutBatchId
        });

        console.log(`✅ Payment successfully processed for ${sanitizedUserId}: $${walletAmount} sent to ${userData.paymentEmail}`);

        return { 
            success: true, 
            transactionId: transactionId,
            payoutBatchId: payoutBatchId,
            amount: walletAmount,
            paymentEmail: userData.paymentEmail,
            error: null
        };

    } catch (error) {
        console.error('Error in payCreator:', error);
        
        return {
            success: false,
            error: error.message,
            transactionId: null
        };
    }
}

export async function recordDeposit(actorId, actorName, campaignId, depositAmount, paymentMethod = "stripe", paymentReference = null) {
    try {
        const reconciliationId = `DEP-${Date.now()}-${actorId}`;
        const IS_SANDBOX = PAYPAL_API_BASE === "https://api.sandbox.paypal.com";

        const transactionEntry = {
            targetUserId: actorId,
            campaignId: campaignId,
            amount: depositAmount,
            type: "campaignDeposit",
            source: "manualDeposit",
            actorId: actorId,
            actorName: actorName,
            status: "completed",
            currency: "USD",
            paymentMethod: paymentMethod,
            paymentReference: paymentReference,
            createdAt: FieldValue.serverTimestamp(),
            isTestPayment: IS_SANDBOX,
            metadata: {
                depositSource: "dashboard",
                platformFee: 0,
                netAmount: depositAmount,
                paymentStatus: "completed",
                reconciliationId: reconciliationId
            }
        };

        const transactionRef = await db.collection('transactions').add(transactionEntry);
        
        return {
            success: true,
            transactionId: transactionRef.id,
            error: null
        };

    } catch (error) {
        console.error('Error recording deposit:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

export async function releaseCampaignPayments(campaignId, actorId) {
    try {
        // Check if actorId is provided
        if (!actorId) {
            return { success: false, message: 'Actor ID is required for authorization.' };
        }

        // Check if actor is an admin
        const isAdmin = await isUserAdmin(actorId);
        if (!isAdmin) {
            return { success: false, message: 'Unauthorized. Only admins can release campaign payments.' };
        }

        const sanitizedCampaignId = sanitizeCampaignId(campaignId);
        const campaignDocRef = db.collection('campaigns').doc(sanitizedCampaignId);
        const campaignDoc = await campaignDocRef.get();

        if (!campaignDoc.exists) {
            return { success: false, message: 'Campaign not found.' };
        }

        const campaignData = campaignDoc.data();
        
        if (campaignData.paymentsReleased) {
            return { success: false, message: 'Payments have already been released for this campaign.' };
        }

        const usersToBePaid = () => {
            const creators = new Set(); // Use Set to avoid duplicates
            const videos = campaignData.videos || [];
            
            videos.forEach(video => {
                if (video.author_id) {
                    creators.add(video.author_id);
                }
            });
            
            return Array.from(creators); // Convert Set back to array
        }

        const paymentsSentToWallets = await sendPaymentsToWallets(campaignData, usersToBePaid());
        
        await campaignDocRef.update({
            paymentsReleased: true,
            paymentsReleasedBy: actorId,
            paymentsReleasedAt: Date.now(),
            paymentReleaseReceipt: paymentsSentToWallets
        });
        
        return { 
            success: true, 
            message: 'Campaign payments released successfully'
        };
    } catch (error) {
        console.error('Error releasing campaign payments:', error);
        return { success: false, error: error.message };
    }
}

async function sendPaymentsToWallets(campaign, usersToBePaid) {
    try {
        let userPayoutData = {};
        const videos = campaign.videos || [];
        let unpaidVideos = [];

        for (const video of videos) {
            // Safely handle earnings - default to 0 if undefined/null/NaN
            const earningsForThisVideo = parseFloat(video.earnings) || 0;
            const authorId = video.author_id;
            
            if (!usersToBePaid.includes(authorId)) {
                continue;
            }

            // Check for conditions that would prevent payment
            if (video.status !== "approved") {
                unpaidVideos.push({
                    payeeId: authorId,
                    reasonNoPaymentSent: "Status was not 'approved'",
                    video
                });
            } else if (earningsForThisVideo <= 0) {
                unpaidVideos.push({
                    payeeId: authorId,
                    reasonNoPaymentSent: "The video has earned $0.00",
                    video
                });
            } else {
                // Only process payment for videos that pass all checks
                if (userPayoutData[authorId]) {
                    userPayoutData[authorId].amountOwed += earningsForThisVideo;
                    userPayoutData[authorId].videos.push(video);
                } else {
                    userPayoutData[authorId] = {
                        payeeId: authorId,
                        amountOwed: earningsForThisVideo,
                        videos: [video]
                    };
                }
            }
        }

        // Add user doc data to each payout entry and prepare wallet updates
        const userIds = Object.keys(userPayoutData);
        const userSnapshots = await Promise.all(
            userIds.map(id => db.collection('users').doc(id).get())
        );

        // Prepare batch operations for wallet updates
        const batch = db.batch();
        const walletUpdateResults = [];

        userSnapshots.forEach(snapshot => {
            if (snapshot.exists) {
                const userData = snapshot.data();
                const userId = snapshot.id;
                const payoutData = userPayoutData[userId];
                
                // Merge user data with payout data
                userPayoutData[userId] = {
                    ...payoutData,
                    ...userData
                };

                // Prepare wallet update
                const userRef = db.collection('users').doc(userId);
                const currentWallet = parseFloat(userData.wallet) || 0;
                const payoutAmount = parseFloat(payoutData.amountOwed) || 0;
                const newWalletAmount = currentWallet + payoutAmount;
                
                batch.update(userRef, {
                    wallet: newWalletAmount
                });

                walletUpdateResults.push({
                    userId: userId,
                    previousWallet: currentWallet,
                    payoutAmount: payoutAmount,
                    newWallet: newWalletAmount,
                    userData: userData
                });
            }
        });
  
        await batch.commit();
        return {
            unpaidVideos: unpaidVideos,
            walletUpdates: walletUpdateResults
        };

    } catch (error) {
        console.error('Error calculating pending campaign payments:', error);
        throw new Error('Failed to calculate pending payments: ' + error.message);
    }
}
