// api/webhook.js
//
// This function listens for Stripe "checkout.session.completed" events,
// figures out which Printful variant was purchased (based on the Size
// and Color custom fields on the Stripe Payment Link), and creates the
// matching order in Printful automatically.
//
// Required environment variables (set these in Vercel, never in this file):
//   STRIPE_SECRET_KEY       - Stripe secret key (starts with sk_live_ or sk_test_)
//   STRIPE_WEBHOOK_SECRET   - Signing secret from the Stripe webhook you'll create
//   PRINTFUL_API_KEY        - Your Printful private token

const Stripe = require('stripe');

// Vercel needs the raw request body (not JSON-parsed) to verify the
// Stripe signature, so we turn off Vercel's automatic body parsing.
export const config = {
  api: {
    bodyParser: false,
  },
};

// ---------------------------------------------------------------------
// VARIANT LOOKUP TABLE
// Maps "Color|Size" (as they appear in your Stripe custom fields) to
// the matching Printful sync_variant id for the Sushi & Soju Tee.
// If you add more products later, add more entries here (or build a
// second table and pick the right one based on which Stripe product
// was purchased).
// ---------------------------------------------------------------------
const VARIANT_LOOKUP = {
  'Black|S': 5395789463,
  'Black|M': 5395789465,
  'Black|L': 5395789467,
  'Black|XL': 5395789469,
  'Black|2XL': 5395789470,
  'Pink|S': 5395789472,
  'Pink|M': 5395789474,
  'Pink|L': 5395789476,
  'Pink|XL': 5395789477,
  'Pink|2XL': 5395789479,
  'Cream|S': 5395789481,
  'Cream|M': 5395789483,
  'Cream|L': 5395789484,
  'Cream|XL': 5395789486,
  'Cream|2XL': 5395789488,
};

// Reads the raw request body as a Buffer (needed for Stripe's signature check)
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Pulls a custom field's value out of a Stripe Checkout Session by its key/label
function getCustomFieldValue(session, fieldKey) {
  if (!session.custom_fields) return null;
  const field = session.custom_fields.find(
    (f) => f.key === fieldKey || f.label?.custom === fieldKey
  );
  if (!field) return null;
  return field.dropdown?.value || field.text?.value || field.numeric?.value || null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const rawBody = await readRawBody(req);
  const signature = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  if (event.type !== 'checkout.session.completed') {
    res.status(200).json({ received: true, skipped: true });
    return;
  }

  const session = event.data.object;

  try {
    const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ['customer_details'],
    });

    const size = getCustomFieldValue(fullSession, 'size') || getCustomFieldValue(fullSession, 'Size');
    const color = getCustomFieldValue(fullSession, 'color') || getCustomFieldValue(fullSession, 'Color');

    if (!size || !color) {
      console.error('Missing size or color on session', session.id, { size, color });
      res.status(200).json({ received: true, error: 'missing_size_or_color' });
      return;
    }

    const lookupKey = `${color}|${size}`;
    const variantId = VARIANT_LOOKUP[lookupKey];

    if (!variantId) {
      console.error('No matching Printful variant for', lookupKey);
      res.status(200).json({ received: true, error: 'no_variant_match', lookupKey });
      return;
    }

    const shipping = fullSession.shipping_details || fullSession.customer_details;
    const address = shipping?.address;

    if (!address) {
      console.error('No shipping address found on session', session.id);
      res.status(200).json({ received: true, error: 'missing_address' });
      return;
    }

    const printfulOrder = {
      recipient: {
        name: shipping?.name || fullSession.customer_details?.name || 'Customer',
        address1: address.line1,
        address2: address.line2 || '',
        city: address.city,
        state_code: address.state,
        country_code: address.country,
        zip: address.postal_code,
        email: fullSession.customer_details?.email,
      },
      items: [
        {
          sync_variant_id: variantId,
          quantity: 1,
        },
      ],
    };

    const printfulResponse = await fetch('https://api.printful.com/orders', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PRINTFUL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(printfulOrder),
    });

    const printfulResult = await printfulResponse.json();

    if (!printfulResponse.ok) {
      console.error('Printful order creation failed:', printfulResult);
      res.status(200).json({ received: true, error: 'printful_error', details: printfulResult });
      return;
    }

    console.log('Printful order created:', printfulResult.result?.id);
    res.status(200).json({ received: true, printful_order_id: printfulResult.result?.id });
  } catch (err) {
    console.error('Unexpected error processing order:', err);
    res.status(200).json({ received: true, error: 'unexpected_error', message: err.message });
  }
};
