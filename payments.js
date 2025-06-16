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

function aggregatePaymentDataPerUser(videos, userMap) {
    const userAggregates = new Map();

    for (const video of videos) {
        const userData = userMap.get(video.author_id);
        if (!userData) {
            console.warn(`User not found for video author_id: ${video.author_id}`);
            continue;
        }

        const amountOwed = video.hasBeenPaid ? 0 : calculateEarnings(video.campaign, video.views);
        
        if (!userAggregates.has(video.author_id)) {
            userAggregates.set(video.author_id, {
                creatorId: video.author_id,
                creatorFirstName: userData.first_name || '',
                creatorLastName: userData.last_name || '',
                creatorEmail: userData.email || '',
                creatorPaymentEmail: userData.paymentEmail || '',
                totalAmount: 0,
                videos: []
            });
        }

        const userAggregate = userAggregates.get(video.author_id);
        userAggregate.totalAmount += amountOwed;
        userAggregate.videos.push({
            videoId: video.id,
            views: video.views,
            amount: amountOwed,
            hasBeenPaid: video.hasBeenPaid
        });
    }

    return Array.from(userAggregates.values());
}

export async function calculatePendingCampaignPayments(campaign) {
    try {
        // Metrics for campaign is updated before submitting request
        const campaignVideos = campaign.videos || [];
        
        // Get all unique author IDs
        const authorIds = [...new Set(campaignVideos.map(video => video.author_id))];
        
        // Fetch all users in one batch
        const userSnapshots = await Promise.all(
            authorIds.map(id => db.collection('users').doc(id).get())
        );
        
        // Create a map of user data for quick lookup
        const userMap = new Map();
        userSnapshots.forEach(snapshot => {
            if (snapshot.exists) {
                const userData = snapshot.data();
                userMap.set(snapshot.id, userData);
            }
        });

        // Aggregate payment data per user
        const result = aggregatePaymentDataPerUser(campaignVideos, userMap);

        return result;
    } catch (error) {
        console.error('Error calculating pending campaign payments:', error);
        throw new Error('Failed to calculate pending payments: ' + error.message);
    }
}

export async function payCreator(payments, { actorId, actorName }) {
    try {
        let receipt = [];
        let hasErrors = false;
        
        // Process each user's payment
        for (const payment of payments) {
            try {
                // Skip if no amount to pay
                if (payment.totalAmount <= 0) {
                    receipt.push({
                        ...payment,
                        hasBeenPaid: true,
                        result: "No payment needed - amount is 0"
                    });
                    continue;
                }

                // Prepare PayPal payout
                const payoutData = {
                    paymentEmail: payment.creatorPaymentEmail,
                    payoutAmount: payment.totalAmount.toFixed(2),
                    id: payment.creatorId
                };

                // Send PayPal payout
                const payoutResult = await sendPayoutBatch([payoutData]);

                // Verify PayPal response
                if (!payoutResult || !payoutResult.batch_header || !payoutResult.batch_header.payout_batch_id) {
                    throw new Error('Invalid PayPal response');
                }

                // Create transaction entry
                const transactionEntry = {
                    targetUserId: payment.creatorId,
                    campaignId: payment.videos[0].campaign.id, // All videos are from same campaign
                    amount: payment.totalAmount,
                    type: "campaignIncome",
                    source: "videoViews",
                    actorId: actorId,
                    actorName: actorName,
                    metadata: {
                        videoIds: payment.videos.map(v => v.videoId),
                        views: payment.videos.map(v => v.views),
                        ratePerMillion: payment.videos[0].campaign.ratePerMillion || 0,
                        payoutBatchId: payoutResult.batch_header.payout_batch_id,
                        timestamp: FieldValue.serverTimestamp()
                    }
                };

                // Add to transactions
                await db.collection('transactions').add(transactionEntry);

                // Update all videos for this user as paid
                const batch = db.batch();
                payment.videos.forEach(video => {
                    const videoRef = db.collection('campaigns')
                        .doc(video.campaign.id)
                        .collection('videos')
                        .doc(video.videoId);
                    batch.update(videoRef, { 
                        hasBeenPaid: true,
                        payoutAmountForVideo: video.amount,
                        paidBy: actorId,
                        paidByName: actorName
                    });
                });
                await batch.commit();

                receipt.push({
                    creatorId: payment.creatorId,
                    creatorFirstName: payment.creatorFirstName,
                    creatorLastName: payment.creatorLastName,
                    creatorEmail: payment.creatorEmail,
                    creatorPaymentEmail: payment.creatorPaymentEmail,
                    hasBeenPaid: true,
                    amount: payment.totalAmount,
                    result: "Payment sent successfully",
                    payoutBatchId: payoutResult.batch_header.payout_batch_id,
                    paidBy: actorId,
                    paidByName: actorName
                });

            } catch (error) {
                hasErrors = true;
                console.error(`Error processing payment for creator ${payment.creatorId}:`, error);
                receipt.push({
                    creatorId: payment.creatorId,
                    creatorFirstName: payment.creatorFirstName,
                    creatorLastName: payment.creatorLastName,
                    creatorEmail: payment.creatorEmail,
                    creatorPaymentEmail: payment.creatorPaymentEmail,
                    hasBeenPaid: false,
                    amount: payment.totalAmount,
                    result: `Payment failed: ${error.message}`
                });
            }
        }

        if (hasErrors) {
            throw new Error('One or more payments failed to process');
        }

        return receipt;
    } catch (error) {
        console.error('Error in payCreator:', error);
        throw error;
    }
}
