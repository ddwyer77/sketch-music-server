import { calculateEarnings, updateCampaignMetrics } from './helper.js';
import { db, FieldValue } from './firebaseAdmin.js';
import axios from 'axios';

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET_KEY = process.env.PAYPAL_SECRET_KEY;
const PAYPAL_API_BASE = process.env.PAYPAL_MODE 

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

// 2. Send payout batch
async function sendPayoutBatch(recipients) {
    const accessToken = await getPayPalAccessToken();
    const payoutItems = recipients.map(user => ({
        recipient_type: 'EMAIL',
        amount: {
        value: user.payoutAmount,
        currency: 'USD',
        },
        receiver: user.paymentEmail,
        note: 'Creator payout',
        sender_item_id: user.id,
    }));

    const body = {
        sender_batch_header: {
        sender_batch_id: `batch_${Date.now()}`,
        email_subject: 'You have a payout!',
        },
        items: payoutItems,
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

export async function calculatePendingCampaignPayments(campaign, usersToBePaid) {
    try {
        // Metrics for campaign is updated before submitting request on front end
        let userPayoutData = {};
        const videos = campaign.videos || [];
        let unpaidVideos = [];

        for (const video of videos) {
            const earningsForThisVideo = video.earnings;
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
            } else if (video.hasBeenPaid === true) {
                unpaidVideos.push({
                    payeeId: authorId,
                    reasonNoPaymentSent: "Video has already been marked as paid",
                    video
                });
            } else if (video.earnings <= 0) {
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

        // Add user doc data to each payout entry
        const userIds = Object.keys(userPayoutData);
        const userSnapshots = await Promise.all(
            userIds.map(id => db.collection('users').doc(id).get())
        );

        userSnapshots.forEach(snapshot => {
            if (snapshot.exists) {
                const userData = snapshot.data();
                const userId = snapshot.id;
                userPayoutData[userId] = {
                    ...userPayoutData[userId],
                    ...userData
                };
            }
        });
        
        const userPayoutArray = Object.values(userPayoutData);
        return {
            pendingPayments: userPayoutArray,
            unpaidVideos: unpaidVideos
        };

    } catch (error) {
        console.error('Error calculating pending campaign payments:', error);
        throw new Error('Failed to calculate pending payments: ' + error.message);
    }
}

export async function payCreator(payments, campaignId, { actorId, actorName }) {
    try {
        let hasErrors = false;
        const campaignDoc = await db.collection('campaigns').doc(campaignId).get();
        const campaignRef = campaignDoc.ref; 
        const campaign = campaignDoc.data();
        const pendingPayments = payments.pendingPayments;
        const processedPayments = []; // Track successful payments for potential rollback
        
        // Process each user's payment
        for (const payment of pendingPayments) {
            let transactionId = null;
            let receiptCreated = false;
            let videosUpdated = false;
            let payoutBatchId = null;
            
            try {
                // Skip if no amount to pay
                if (payment.amountOwed <= 0) {
                    console.log(`Skipping payment for ${payment.payeeId} - amount is 0`);
                    continue;
                }

                const reconciliationId = `PAY-${Date.now()}-${payment.payeeId}`;

                // PHASE 1: Prepare all data and validate everything BEFORE sending money
                // Validate payment data
                if (!payment.paymentEmail || !payment.payeeId || payment.amountOwed <= 0) {
                    throw new Error('Invalid payment data');
                }

                // Pre-validate all videos exist in database

                if (!campaignDoc.exists) {
                    throw new Error(`Campaign ${campaignId} not found`);
                }
                const campaignVideos = campaignDoc.data().videos || [];
                const videoRefs = [];
                
                for (const video of payment.videos) {
                    const matchingVideos = campaignVideos.filter(v => v.url === video.url);
                    if (matchingVideos.length !== 1) {
                        throw new Error(`Video with URL ${video.url} ${matchingVideos.length === 0 ? 'not found' : 'has duplicates'} in campaign ${campaignId}`);
                    }
                    
                    videoRefs.push({
                        campaignRef: campaignDoc.ref,
                        video: matchingVideos[0]
                    });
                }

                // Prepare all database objects BEFORE sending money
                const transactionEntry = {
                    targetUserId: payment.payeeId,
                    targetFirstName: payment.firstName,
                    targetLastName: payment.lastName,
                    campaignId: campaignId,
                    amount: -payment.amountOwed,
                    type: "creatorPayout",
                    source: "videoViews",
                    actorId: actorId,
                    actorName: actorName,
                    status: "pending", // Start as pending
                    currency: "USD",
                    paymentMethod: "paypal",
                    paymentReference: null, // Will be updated after PayPal
                    createdAt: FieldValue.serverTimestamp(),
                    isTestPayment: PAYPAL_API_BASE === "https://api.sandbox.paypal.com",
                    metadata: {
                        videoIds: payment.videos.map(v => v.id),
                        views: payment.videos.map(v => v.views),
                        ratePerMillion: campaign.ratePerMillion || 0,
                        payoutBatchId: null, // Will be updated after PayPal
                        timestamp: FieldValue.serverTimestamp(),
                        paymentEmail: payment.paymentEmail,
                        videoCount: payment.videos.length,
                        totalViews: payment.videos.reduce((sum, v) => sum + (v.views || 0), 0),
                        platformFee: 0,
                        netAmount: payment.amountOwed,
                        paymentStatus: "pending",
                        reconciliationId: reconciliationId
                    }
                };

                const receipt = {
                    receiptId: `REC-${Date.now()}-${payment.payeeId}`,
                    campaignId: campaignId,
                    creator: {
                        id: payment.payeeId,
                        firstName: payment.firstName,
                        lastName: payment.lastName,
                        email: payment.email,
                        paymentEmail: payment.paymentEmail
                    },
                    payment: {
                        amount: payment.amountOwed,
                        currency: "USD",
                        status: "pending", // Start as pending
                        method: "paypal",
                        batchId: null, // Will be updated after PayPal
                        timestamp: new Date()
                    },
                    videos: {
                        paid: payment.videos.map(video => ({
                            url: video.url,
                            title: video.title,
                            views: video.views,
                            earnings: video.earnings,
                            ratePerMillion: campaign.ratePerMillion
                        })),
                        unpaid: payments.unpaidVideos
                    },
                    summary: {
                        totalVideos: payment.videos.length,
                        totalViews: payment.videos.reduce((sum, v) => sum + (v.views || 0), 0),
                        platformFee: 0,
                        netAmount: payment.amountOwed,
                        unpaidVideosCount: payments.unpaidVideos.length
                    },
                    metadata: {
                        processedBy: {
                            id: actorId,
                            name: actorName
                        },
                        transactionId: reconciliationId,
                        paymentReference: null // Will be updated after PayPal
                    }
                };

                // PHASE 2: Create transaction record as "pending" BEFORE sending money
                const transactionRef = await db.collection('transactions').add(transactionEntry);
                transactionId = transactionRef.id;

                // PHASE 3: Send PayPal payout (the critical step)
                const payoutData = {
                    paymentEmail: payment.paymentEmail,
                    payoutAmount: payment.amountOwed.toFixed(2),
                    id: payment.payeeId
                };

                const payoutResult = await sendPayoutBatch([payoutData]);

                // Verify PayPal response
                if (!payoutResult || !payoutResult.batch_header || !payoutResult.batch_header.payout_batch_id) {
                    throw new Error('Invalid PayPal response');
                }

                payoutBatchId = payoutResult.batch_header.payout_batch_id;

                // PHASE 4: Update transaction to "completed" now that money was sent
                await transactionRef.update({
                    status: "completed",
                    paymentReference: payoutBatchId,
                    'metadata.payoutBatchId': payoutBatchId,
                    'metadata.paymentStatus': "completed",
                    completedAt: FieldValue.serverTimestamp()
                });

                // PHASE 5: Mark videos as paid
                const updatedCampaignVideos = [...campaignVideos];
                for (const video of payment.videos) {
                    const videoIndex = updatedCampaignVideos.findIndex(v => v.url === video.url);
                    updatedCampaignVideos[videoIndex] = {
                        ...updatedCampaignVideos[videoIndex],
                        hasBeenPaid: true,
                        payoutAmountForVideo: video.earnings,
                        paidBy: actorId,
                        paidByName: actorName,
                        paidAt: new Date(),
                        payoutBatchId: payoutBatchId
                    };
                }
                await campaignRef.update({
                    videos: updatedCampaignVideos
                });
                videosUpdated = true;

                // PHASE 6: Create receipt with final PayPal info
                receipt.payment.status = "completed";
                receipt.payment.batchId = payoutBatchId;
                receipt.metadata.paymentReference = payoutBatchId;
             
                await campaignRef.update({
                    receipts: FieldValue.arrayUnion(receipt)
                });
                receiptCreated = true;

                // Track successful payment for potential rollback
                processedPayments.push({
                    payeeId: payment.payeeId,
                    transactionId: transactionId,
                    payoutBatchId: payoutBatchId,
                    reconciliationId: reconciliationId
                });

                console.log(`✅ Payment successfully processed for ${payment.payeeId}`);

            } catch (error) {
                hasErrors = true;
                console.error(`❌ Error processing payment for creator ${payment.payeeId}:`, error);

                // ROLLBACK LOGIC: Clean up partial state
                try {
                    if (transactionId) {
                        console.log(`Rolling back transaction ${transactionId}...`);
                        await db.collection('transactions').doc(transactionId).update({
                            status: "failed",
                            failureReason: error.message,
                            failedAt: FieldValue.serverTimestamp()
                        });
                    }

                    // Note: We CANNOT rollback PayPal payments automatically
                    // This would need manual intervention or PayPal API calls to reverse
                    if (payoutBatchId) {
                        console.error(`⚠️  CRITICAL: PayPal payment ${payoutBatchId} succeeded but database updates failed. Manual reconciliation required.`);
                        
                        // Log this for manual review
                        await db.collection('failed_payments').add({
                            payeeId: payment.payeeId,
                            payoutBatchId: payoutBatchId,
                            error: error.message,
                            needsManualReconciliation: true,
                            createdAt: FieldValue.serverTimestamp(),
                            transactionId: transactionId
                        });
                    }
                } catch (rollbackError) {
                    console.error(`Failed to rollback payment ${payment.payeeId}:`, rollbackError);
                }

                throw error; // Re-throw to be caught by outer try-catch
            }
        }

        if (hasErrors) {
            throw new Error('One or more payments failed to process');
        }

        return { 
            success: true, 
            processedPayments: processedPayments.length,
            error: null
        };

    } catch (error) {
        console.error('Error in payCreator:', error);
        
        // Log the failure with all successful payments for audit
        await db.collection('payment_batches').add({
            status: 'failed',
            error: error.message,
            successfulPayments: processedPayments,
            failedAt: FieldValue.serverTimestamp(),
            campaignId: campaign.id,
            processedBy: { id: actorId, name: actorName }
        });
        
        return {
            success: false,
            error: error.message,
            processedPayments: 0
        };
    }
}


