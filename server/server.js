/**
 * ════════════════════════════════════════════════════════════════
 *  SCOUT AXIS — BACKEND SERVER
 *  Node.js + Express + Stripe + Supabase
 * ════════════════════════════════════════════════════════════════
 *
 *  SETUP:
 *    1.  npm install express stripe @supabase/supabase-js cors dotenv
 *    2.  Copy .env.example → .env and fill in your keys
 *    3.  node server.js  (or: npx nodemon server.js for dev)
 *    4.  Set BACKEND_URL in index.html to wherever this is deployed
 *        e.g. https://scout-axis-backend.fly.dev
 *
 *  STRIPE SETUP (do once in your Stripe dashboard):
 *    1.  Create two products: "Scout" and "Pro Scout"
 *    2.  Add monthly + annual prices to each
 *    3.  Copy the Price IDs (price_xxxxx) into .env
 *    4.  Set webhook endpoint: https://your-domain.com/api/webhook
 *        Events to listen for:
 *          - customer.subscription.updated
 *          - customer.subscription.deleted
 *          - invoice.payment_failed
 *          - invoice.payment_succeeded
 *
 *  DEPLOY (free options):
 *    - Railway:   railway up
 *    - Fly.io:    fly launch && fly deploy
 *    - Render:    connect GitHub repo → auto-deploys
 * ════════════════════════════════════════════════════════════════
 */

require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const Stripe    = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const app    = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const sb     = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── Middleware ──
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
// Raw body for Stripe webhook signature verification — must come BEFORE express.json()
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ══════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════

async function loadUsers() {
  const { data, error } = await sb
    .from('hcrs_store')
    .select('value')
    .eq('key', 'hcrs_users')
    .maybeSingle();
  if (error || !data) return [];
  try { return JSON.parse(data.value); } catch(e) { return []; }
}

async function saveUsers(users) {
  await sb.from('hcrs_store').upsert(
    { key: 'hcrs_users', value: JSON.stringify(users) },
    { onConflict: 'key' }
  );
}

async function updateUserByStripeId(stripeCustomerId, patch) {
  const users = await loadUsers();
  const idx = users.findIndex(u => u.stripeCustomerId === stripeCustomerId);
  if (idx === -1) return false;
  users[idx] = { ...users[idx], ...patch };
  await saveUsers(users);
  return true;
}

async function updateUserByUsername(username, patch) {
  const users = await loadUsers();
  const idx = users.findIndex(u => u.username.toLowerCase() === username.toLowerCase());
  if (idx === -1) return false;
  users[idx] = { ...users[idx], ...patch };
  await saveUsers(users);
  return true;
}

// ══════════════════════════════════════════════════════════════
//  POST /api/subscribe
//  Creates a Stripe customer + subscription, returns IDs
// ══════════════════════════════════════════════════════════════
app.post('/api/subscribe', async (req, res) => {
  const { email, username, priceId, paymentMethodId, trial_period_days = 7 } = req.body;

  // Validate required fields
  if (!email || !username || !priceId || !paymentMethodId) {
    return res.status(400).json({ error: 'Missing required fields (email, username, priceId, paymentMethodId).' });
  }

  try {
    // 1. Use the PaymentMethod token created client-side by Stripe.js
    //    The frontend calls stripe.createPaymentMethod() and only sends the
    //    resulting paymentMethodId here — raw card data never touches your server.
    const paymentMethodId = req.body.paymentMethodId;
    if (!paymentMethodId) {
      return res.status(400).json({ error: 'Missing paymentMethodId. Use Stripe.js on the frontend.' });
    }

    // 2. Create or retrieve Stripe Customer
    const existingCustomers = await stripe.customers.list({ email, limit: 1 });
    let customer;
    if (existingCustomers.data.length > 0) {
      customer = existingCustomers.data[0];
    } else {
      customer = await stripe.customers.create({
        email,
        name: username,
        metadata: { scoutaxis_username: username },
      });
    }

    // 3. Attach PaymentMethod to customer and set as default
    await stripe.paymentMethods.attach(paymentMethodId, { customer: customer.id });
    await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    // 4. Create Subscription with trial
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      trial_period_days,
      default_payment_method: paymentMethodId,
      metadata: { scoutaxis_username: username },
      expand: ['latest_invoice.payment_intent'],
    });

    // 5. Calculate next billing date (after trial)
    const nextBillingDate = new Date(subscription.current_period_end * 1000).toISOString();

    return res.json({
      customerId:     customer.id,
      subscriptionId: subscription.id,
      status:         subscription.status, // 'trialing' | 'active' | etc.
      nextBillingDate,
    });

  } catch (err) {
    console.error('[Stripe] subscribe error:', err.message);
    // Surface friendly Stripe card errors
    if (err.type === 'StripeCardError') {
      return res.status(402).json({ error: err.message });
    }
    return res.status(500).json({ error: 'Payment processing failed. Please try again.' });
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /api/cancel
//  Cancels a subscription at period end (user keeps access until billing date)
// ══════════════════════════════════════════════════════════════
app.post('/api/cancel', async (req, res) => {
  const { username, stripeSubscriptionId } = req.body;
  if (!stripeSubscriptionId) return res.status(400).json({ error: 'Missing subscription ID.' });

  try {
    // Cancel at end of billing period — user keeps access until then
    await stripe.subscriptions.update(stripeSubscriptionId, {
      cancel_at_period_end: true,
    });
    // Mark in our DB that cancellation is pending
    await updateUserByUsername(username, { subscriptionStatus: 'cancelling' });
    return res.json({ success: true, message: 'Subscription will cancel at period end.' });
  } catch(err) {
    console.error('[Stripe] cancel error:', err.message);
    return res.status(500).json({ error: 'Failed to cancel subscription.' });
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /api/reactivate
//  Reactivates a subscription that was set to cancel_at_period_end
// ══════════════════════════════════════════════════════════════
app.post('/api/reactivate', async (req, res) => {
  const { username, stripeSubscriptionId } = req.body;
  if (!stripeSubscriptionId) return res.status(400).json({ error: 'Missing subscription ID.' });

  try {
    await stripe.subscriptions.update(stripeSubscriptionId, { cancel_at_period_end: false });
    await updateUserByUsername(username, { subscriptionStatus: 'active', active: true });
    return res.json({ success: true });
  } catch(err) {
    console.error('[Stripe] reactivate error:', err.message);
    return res.status(500).json({ error: 'Failed to reactivate subscription.' });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/subscription-status/:username
//  Admin or the user themselves can check current subscription status
// ══════════════════════════════════════════════════════════════
app.get('/api/subscription-status/:username', async (req, res) => {
  const { username } = req.params;
  const users = await loadUsers();
  const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return res.status(404).json({ error: 'User not found.' });

  // If they have a Stripe subscription ID, fetch live status
  if (user.stripeSubscriptionId) {
    try {
      const sub = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
      const liveStatus = sub.status; // active, trialing, past_due, canceled, etc.
      // Sync back to our DB if it changed
      if (liveStatus !== user.subscriptionStatus) {
        const newActive = ['active','trialing'].includes(liveStatus);
        await updateUserByUsername(username, {
          subscriptionStatus: liveStatus,
          active: newActive,
          nextBillingDate: new Date(sub.current_period_end * 1000).toISOString(),
        });
      }
      return res.json({
        username,
        status:          liveStatus,
        active:          ['active','trialing'].includes(liveStatus),
        nextBillingDate: new Date(sub.current_period_end * 1000).toISOString(),
        cancelAtPeriodEnd: sub.cancel_at_period_end,
      });
    } catch(err) {
      console.error('[Stripe] status fetch error:', err.message);
    }
  }

  // Fall back to our stored status
  return res.json({
    username,
    status:  user.subscriptionStatus || 'unknown',
    active:  user.active !== false,
    nextBillingDate: user.nextBillingDate || null,
  });
});

// ══════════════════════════════════════════════════════════════
//  POST /api/webhook
//  Stripe sends events here — CRITICAL: this is what keeps
//  subscription statuses in sync automatically
// ══════════════════════════════════════════════════════════════
app.post('/api/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch(err) {
    console.error('[Webhook] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const sub  = event.data?.object;
  const cid  = sub?.customer;

  switch (event.type) {

    // ── Trial ended, subscription now active ──
    case 'customer.subscription.updated': {
      const status = sub.status;
      const nextBill = new Date(sub.current_period_end * 1000).toISOString();
      const isActive = ['active','trialing'].includes(status);
      await updateUserByStripeId(cid, {
        subscriptionStatus: status,
        active: isActive,
        nextBillingDate: nextBill,
      });
      console.log(`[Webhook] subscription.updated → ${cid}: ${status}`);
      break;
    }

    // ── Subscription cancelled (period ended or immediate) ──
    case 'customer.subscription.deleted': {
      await updateUserByStripeId(cid, {
        subscriptionStatus: 'deactivated',
        active: false,
      });
      console.log(`[Webhook] subscription.deleted → ${cid}: deactivated`);
      break;
    }

    // ── Payment failed (e.g. card expired) ──
    case 'invoice.payment_failed': {
      await updateUserByStripeId(cid, {
        subscriptionStatus: 'past_due',
        // Do NOT set active: false yet — give them the grace period Stripe allows
      });
      console.log(`[Webhook] invoice.payment_failed → ${cid}: past_due`);
      break;
    }

    // ── Payment succeeded (renewal) ──
    case 'invoice.payment_succeeded': {
      const nextBill = sub.lines?.data?.[0]?.period?.end
        ? new Date(sub.lines.data[0].period.end * 1000).toISOString()
        : null;
      await updateUserByStripeId(cid, {
        subscriptionStatus: 'active',
        active: true,
        ...(nextBill ? { nextBillingDate: nextBill } : {}),
      });
      console.log(`[Webhook] invoice.payment_succeeded → ${cid}: renewed`);
      break;
    }

    default:
      // Unhandled event — not an error, just ignore
      break;
  }

  res.json({ received: true });
});

// ══════════════════════════════════════════════════════════════
//  GET /health  — simple uptime check
// ══════════════════════════════════════════════════════════════
app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

// ══════════════════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Scout Axis backend listening on port ${PORT}`);
  if (!process.env.STRIPE_SECRET_KEY) console.warn('⚠  STRIPE_SECRET_KEY not set');
  if (!process.env.STRIPE_WEBHOOK_SECRET) console.warn('⚠  STRIPE_WEBHOOK_SECRET not set');
  if (!process.env.SUPABASE_URL) console.warn('⚠  SUPABASE_URL not set');
  if (!process.env.SUPABASE_SERVICE_KEY) console.warn('⚠  SUPABASE_SERVICE_KEY not set');
});
