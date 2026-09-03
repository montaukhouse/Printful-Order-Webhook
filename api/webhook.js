// api/webhook.js
//
// Listens for Stripe "checkout.session.completed" events, figures out
// which Printful product/variant was purchased, and creates the
// matching order in Printful automatically.
//
// Required environment variables (set these in Vercel, never in this file):
//   STRIPE_SECRET_KEY       - Stripe secret key (starts with sk_live_ or sk_test_)
//   STRIPE_WEBHOOK_SECRET   - Signing secret from the Stripe webhook destination
//   PRINTFUL_API_KEY        - Your Printful private token

const Stripe = require('stripe');

export const config = {
  api: {
    bodyParser: false,
  },
};

const PRODUCT_CONFIG = [
  {
    match: 'sushi & soju tee',
    needsSize: true,
    needsColor: true,
    variantsByColorSize: {
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
    },
  },
  {
    match: 'evil innocence tee - black',
    needsSize: true,
    variantsBySize: {
      S: 5455690755,
      M: 5455690756,
      L: 5455690757,
      XL: 5455690758,
      '2XL': 5455690759,
    },
  },
  {
    match: 'evil innocence tee - white',
    needsSize: true,
    variantsBySize: {
      S: 5455697250,
      M: 5455697251,
      L: 5455697252,
      XL: 5455697253,
      '2XL': 5455697254,
    },
  },
  {
    match: 'evil innocence cap',
    needsSize: false,
    variantId: 5455718274,
  },
  {
    match: 'embri beanie',
    needsSize: false,
    variantId: 5455722008,
  },
  {
    match: 'evil innocence tote bag',
    needsSize: false,
    variantId: 5455842578,
  },
];

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function getCustomFieldValue(session, fieldKey) {
  if (!session.custom_fields) return null;
  const field = session.custom_fields.find(
    (f) => f.key === fieldKey || f.label?.custom === fieldKey
  );
  if (!field) return null;
  return field.dropdown?.value || field.text?.value || field.numeric?.value || null;
}

function findProductConfig(lineItemNames) {
  const lowerNames = lineItemNames.map((n) => n.toLowerCase());
  return PRODUCT_CONFIG.find((config) =>
    lowerNames.some((name) => name.includes(config.match))
  );
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
      expand: ['customer_details', 'line_items'],
    });

    const lineItemNames = (fullSession.line_items?.data || []).map(
      (item) => item.description || ''
    );

    const productConfig = findProductConfig(lineItemNames);

    if (!productConfig) {
      console.log('No matching Printful product for session', session.id, lineItemNames);
      res.status(200).json({ received: true, skipped: true, reason: 'no_product_match' });
      return;
    }

    let variantId;

    if (productConfig.needsColor) {
      const size = getCustomFieldValue(fullSession, 'size') || getCustomFieldValue(fullSession, 'Size');
      const color = getCustomFieldValue(fullSession, 'color') || getCustomFieldValue(fullSession, 'Color');

      if (!size || !color) {
        console.error('Missing size or color on session', session.id, { size, color });
        res.status(200).json({ received: true, error: 'missing_size_or_color' });
        return;
      }

      variantId = productConfig.variantsByColorSize[`${color}|${size}`];
    } else if (productConfig.needsSize) {
      const size = getCustomFieldValue(fullSession, 'size') || getCustomFieldValue(fullSession, 'Size');

      if (!size) {
        console.error('Missing size on session', session.id);
        res.status(200).json({ received: true, error: 'missing_size' });
        return;
      }

      variantId = productConfig.variantsBySize[size];
    } else {
      variantId = productConfig.variantId;
    }

    if (!variantId) {
      console.error('No matching Printful variant found for session', session.id);
      res.status(200).json({ received: true, error: 'no_variant_match' });
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
