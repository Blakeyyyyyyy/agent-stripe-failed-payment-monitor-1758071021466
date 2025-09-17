const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');
const app = express();

app.use(express.json());

// Email setup using SMTP
const transporter = nodemailer.createTransporter({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || 'your-email@gmail.com',
    pass: process.env.EMAIL_PASSWORD || 'your-app-password'
  }
});

let logs = [];
const addLog = (message) => {
  const timestamp = new Date().toISOString();
  logs.push(`[${timestamp}] ${message}`);
  console.log(message);
  // Keep only last 100 logs
  if (logs.length > 100) logs = logs.slice(-100);
};

// Send email function
async function sendFailedPaymentAlert(charge) {
  try {
    const subject = `🚨 Payment Failed - $${(charge.amount/100).toFixed(2)} ${charge.currency.toUpperCase()}`;
    const htmlBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px;">
        <h2 style="color: #d32f2f;">⚠️ Payment Failed Alert</h2>
        
        <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3>Payment Details</h3>
          <p><strong>Customer:</strong> ${charge.billing_details?.name || 'Unknown'}</p>
          <p><strong>Email:</strong> ${charge.billing_details?.email || 'Unknown'}</p>
          <p><strong>Amount:</strong> $${(charge.amount/100).toFixed(2)} ${charge.currency.toUpperCase()}</p>
          <p><strong>Charge ID:</strong> ${charge.id}</p>
          <p><strong>Failure Code:</strong> ${charge.outcome?.network_status || 'Unknown'}</p>
          <p><strong>Failure Reason:</strong> ${charge.outcome?.reason || 'Unknown'}</p>
          <p><strong>Date:</strong> ${new Date(charge.created * 1000).toLocaleString()}</p>
        </div>
        
        <p>
          <a href="https://dashboard.stripe.com/payments/${charge.id}" 
             style="background: #635bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
            View in Stripe Dashboard
          </a>
        </p>
        
        <hr>
        <p style="color: #666; font-size: 12px;">
          This alert was sent by your Stripe Failed Payment Monitor agent.
        </p>
      </div>
    `;

    const textBody = `
Payment Failed Alert

Customer: ${charge.billing_details?.name || 'Unknown'}
Email: ${charge.billing_details?.email || 'Unknown'}
Amount: $${(charge.amount/100).toFixed(2)} ${charge.currency.toUpperCase()}
Charge ID: ${charge.id}
Failure Code: ${charge.outcome?.network_status || 'Unknown'}
Failure Message: ${charge.outcome?.reason || 'Unknown'}
Date: ${new Date(charge.created * 1000).toLocaleString()}

View in Stripe: https://dashboard.stripe.com/payments/${charge.id}
    `;

    const mailOptions = {
      from: process.env.EMAIL_USER || 'your-email@gmail.com',
      to: process.env.ALERT_EMAIL || process.env.EMAIL_USER || 'your-email@gmail.com',
      subject: subject,
      text: textBody,
      html: htmlBody
    };

    await transporter.sendMail(mailOptions);
    addLog(`✅ Email alert sent for failed payment: ${charge.id}`);
    return true;
  } catch (error) {
    addLog(`❌ Failed to send email for charge ${charge.id}: ${error.message}`);
    return false;
  }
}

// Webhook endpoint for Stripe events
app.post('/webhook', async (req, res) => {
  try {
    const event = req.body;
    addLog(`📡 Received Stripe webhook: ${event.type}`);

    // Handle failed payments
    if (event.type === 'charge.failed') {
      const charge = event.data.object;
      addLog(`💳 Processing failed payment: ${charge.id} - $${(charge.amount/100).toFixed(2)} ${charge.currency}`);
      
      await sendFailedPaymentAlert(charge);
    }
    
    // Handle failed invoice payments
    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      addLog(`📄 Processing failed invoice payment: ${invoice.id} - $${(invoice.amount_due/100).toFixed(2)} ${invoice.currency}`);
      
      // Create charge-like object for consistency
      const chargeData = {
        id: invoice.id,
        amount: invoice.amount_due,
        currency: invoice.currency,
        billing_details: {
          name: invoice.customer_name,
          email: invoice.customer_email
        },
        outcome: {
          network_status: 'declined_by_network',
          reason: 'invoice_payment_failed'
        },
        created: invoice.created
      };
      
      await sendFailedPaymentAlert(chargeData);
    }
    
    res.json({ received: true });
  } catch (error) {
    addLog(`❌ Webhook error: ${error.message}`);
    res.status(400).json({ error: error.message });
  }
});

// Manual check for recent failed payments
app.post('/check-failed-payments', async (req, res) => {
  try {
    addLog('🔍 Manually checking for recent failed payments...');
    
    const charges = await stripe.charges.list({
      limit: 100,
      created: { gte: Math.floor(Date.now() / 1000) - 86400 } // Last 24 hours
    });

    const failedCharges = charges.data.filter(charge => !charge.paid);
    
    addLog(`Found ${failedCharges.length} failed payments in the last 24 hours`);
    
    let emailsSent = 0;
    for (const charge of failedCharges) {
      const success = await sendFailedPaymentAlert(charge);
      if (success) emailsSent++;
    }

    res.json({
      success: true,
      failedPayments: failedCharges.length,
      emailsSent,
      charges: failedCharges.map(c => ({
        id: c.id,
        amount: c.amount/100,
        currency: c.currency,
        customer: c.billing_details?.email,
        created: new Date(c.created * 1000).toISOString(),
        failure_reason: c.outcome?.reason
      }))
    });
  } catch (error) {
    addLog(`❌ Error checking failed payments: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Test endpoint
app.post('/test', async (req, res) => {
  try {
    addLog('🧪 Running test...');
    
    // Test Stripe connection
    const account = await stripe.accounts.retrieve();
    addLog(`✅ Stripe connected: ${account.display_name || account.id}`);
    
    // Test email (send test notification)
    const testCharge = {
      id: 'ch_test_' + Date.now(),
      amount: 2500,
      currency: 'usd',
      billing_details: {
        name: 'Test Customer',
        email: 'test@example.com'
      },
      outcome: {
        network_status: 'declined_by_network',
        reason: 'insufficient_funds'
      },
      created: Math.floor(Date.now() / 1000)
    };
    
    const emailSent = await sendFailedPaymentAlert(testCharge);
    
    res.json({
      success: true,
      message: 'Test completed successfully',
      stripe_account: account.display_name || account.id,
      test_email_sent: emailSent,
      webhook_url: `${req.protocol}://${req.get('host')}/webhook`
    });
  } catch (error) {
    addLog(`❌ Test failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Setup webhook endpoint
app.post('/setup-webhook', async (req, res) => {
  try {
    const webhookUrl = `${req.protocol}://${req.get('host')}/webhook`;
    
    // Register webhook with Stripe
    const webhook = await stripe.webhookEndpoints.create({
      url: webhookUrl,
      enabled_events: [
        'charge.failed',
        'invoice.payment_failed'
      ]
    });
    
    addLog(`✅ Webhook registered: ${webhook.id} -> ${webhookUrl}`);
    
    res.json({
      success: true,
      webhook_id: webhook.id,
      webhook_url: webhookUrl,
      events: webhook.enabled_events
    });
  } catch (error) {
    addLog(`❌ Failed to setup webhook: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Status endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'Stripe Failed Payment Monitor',
    status: 'running',
    endpoints: [
      'POST /webhook - Receive Stripe webhooks (for real-time alerts)',
      'POST /check-failed-payments - Manual check for failed payments',
      'POST /setup-webhook - Automatically register webhook with Stripe',
      'POST /test - Test connections and send sample alert',
      'GET /health - Health check',
      'GET /logs - View recent activity'
    ],
    uptime: process.uptime(),
    last_activity: logs.length > 0 ? logs[logs.length - 1] : 'No activity yet',
    webhook_url: `${req.protocol}://${req.get('host')}/webhook`
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: {
      stripe_configured: !!process.env.STRIPE_SECRET_KEY,
      email_configured: !!(process.env.EMAIL_USER && process.env.EMAIL_PASSWORD)
    }
  });
});

// Logs endpoint
app.get('/logs', (req, res) => {
  res.json({
    logs: logs.slice(-50), // Last 50 logs
    total_logs: logs.length
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  addLog(`🚀 Stripe Failed Payment Monitor started on port ${PORT}`);
  addLog(`📧 Email alerts will be sent to: ${process.env.ALERT_EMAIL || process.env.EMAIL_USER || 'NOT_CONFIGURED'}`);
  addLog(`🔗 Webhook URL: http://localhost:${PORT}/webhook (update after deployment)`);
});