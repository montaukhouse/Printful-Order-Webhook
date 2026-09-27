// api/webhook.js
// redeploy trigger 1
//
// Listens for Stripe "checkout.session.completed" events, figures out
// which Printful product/variant was purchased, and creates the
// matching order in Printful automatically.
//
// Required environment variables (set these in Vercel, never in this file):
//   STRIPE_SECRET_KEY       - Stripe secret key (starts with sk_live_ or sk_test_)
//   STRIPE_WEBHOOK_SECRET   - Signing secret from the Stripe webhook destination
//   PRINTFUL_API_KEY        - Your Printful private token
//
// Album purchases (digital) don't go to Printful. Instead the buyer gets a
// confirmation email with a personal link that unlocks the album on any browser.
//   BREVO_API_KEY           - Brevo API key (already set for subscribe.js)
//   UNLOCK_SECRET           - Long random string; must match the Embri-Web-App project
//   ALBUM_EMAIL_SENDER      - Verified Brevo sender, e.g. hello@embriofficial.com
//   SITE_URL                - Optional, defaults to https://embriofficial.com

const Stripe = require('stripe');
const crypto = require('crypto');

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

  if (field.dropdown) {
    const matchedOption = field.dropdown.options?.find(
      (o) => o.value === field.dropdown.value
    );
    return matchedOption?.label || field.dropdown.value || null;
  }

  return field.text?.value || field.numeric?.value || null;
}

// ---- Album unlock email ----
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function makeUnlockToken(email) {
  const e = email.trim().toLowerCase();
  const sig = crypto.createHmac('sha256', process.env.UNLOCK_SECRET).update(e).digest();
  return `${b64url(e)}.${b64url(sig)}`;
}
function isAlbumPurchase(lineItemNames) {
  return lineItemNames.some((n) => {
    const name = n.toLowerCase().trim();
    return name.includes('album') || name === 'evil innocence';
  });
}
async function sendAlbumEmail(email, name) {
  const site = process.env.SITE_URL || 'https://embriofficial.com';
  const link = `${site}/?unlock=${encodeURIComponent(makeUnlockToken(email))}#listen`;
  const appLink = `${site}/?unlock=${encodeURIComponent(makeUnlockToken(email))}&install=1#listen`;
  const first = (name || '').split(' ')[0];
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: 'Embri', email: process.env.ALBUM_EMAIL_SENDER },
      to: [{ email, name: name || undefined }],
      subject: 'Your Evil Innocence album is unlocked 🖤',
      htmlContent: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#111">
          <h2 style="margin:0 0 12px">Thank you${first ? ', ' + first : ''} 🖤</h2>
          <p>Your purchase of <b>Evil Innocence</b> is confirmed. All 12 tracks are yours to stream.</p>
          <p>Use the button below to listen on any phone, tablet, or computer. It's your personal link, so save this email.</p>
          <p style="margin:24px 0"><a href="${link}" style="background:#111;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">Listen to the album</a></p>
          <p style="margin:0 0 8px"><a href="${appLink}" style="display:inline-block;background:#1f8f4e;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">📱 Get the Embri app</a></p>
          <p style="font-size:13px;color:#666;margin:0 0 20px">Keep the album on your phone like an app. It opens already unlocked and plays offline.</p>
          <p style="font-size:13px;color:#666">Questions? Reply to hello@embriofficial.com.</p>
          <p style="font-size:13px;color:#666">— Embri</p>
        </div>`,
    }),
  });
  if (!r.ok) throw new Error(`Brevo ${r.status}: ${await r.text()}`);
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

    if (isAlbumPurchase(lineItemNames)) {
      const email = fullSession.customer_details?.email;
      if (!email) {
        console.error('Album purchase with no email on session', session.id);
        res.status(200).json({ received: true, error: 'album_missing_email' });
        return;
      }
      await sendAlbumEmail(email, fullSession.customer_details?.name);
      console.log('Album unlock email sent for session', session.id);
      res.status(200).json({ received: true, album_email_sent: true });
      return;
    }

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
        console.error('Raw custom_fields:', JSON.stringify(fullSession.custom_fields));
        res.status(200).json({
          received: true,
          error: 'missing_size_or_color',
          raw_custom_fields: fullSession.custom_fields ?? 'UNDEFINED_OR_NULL',
          session_top_level_keys: Object.keys(fullSession),
        });
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
      console.error('Raw custom_fields:', JSON.stringify(fullSession.custom_fields));
      res.status(200).json({
        received: true,
        error: 'no_variant_match',
        raw_custom_fields: fullSession.custom_fields ?? 'UNDEFINED_OR_NULL',
        session_top_level_keys: Object.keys(fullSession),
      });
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
