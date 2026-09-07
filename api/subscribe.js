// api/subscribe.js
//
// Receives an email address from embriofficial.com and adds it as a contact
// to Brevo list ID 11, which triggers the welcome email automation.
//
// Required environment variable (set in Vercel dashboard):
//   BREVO_API_KEY - your Brevo API key

const BREVO_LIST_ID = 11;

export default async function handler(req, res) {
  // Allow the website to call this function
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, firstName } = req.body || {};

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.error('BREVO_API_KEY is not set');
    return res.status(500).json({ error: 'Server not configured' });
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'api-key': apiKey
      },
      body: JSON.stringify({
        email: email,
        attributes: firstName ? { FIRSTNAME: firstName } : {},
        listIds: [BREVO_LIST_ID],
        updateEnabled: true
      })
    });

    // Brevo returns 201 for new contact, 204 for updated existing contact
    if (response.status === 201 || response.status === 204) {
      return res.status(200).json({ success: true });
    }

    // If the contact already exists, Brevo may return 400 with a specific code.
    // Treat that as success so returning fans don't see an error.
    const data = await response.json().catch(() => ({}));
    if (data.code === 'duplicate_parameter') {
      return res.status(200).json({ success: true, note: 'already subscribed' });
    }

    console.error('Brevo error:', response.status, data);
    return res.status(500).json({ error: 'Could not subscribe' });

  } catch (err) {
    console.error('Subscribe failed:', err);
    return res.status(500).json({ error: 'Could not subscribe' });
  }
}
