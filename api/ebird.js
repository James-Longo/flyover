const fetch = require('node-fetch');

module.exports = async (req, res) => {
  const { path } = req.query;
  const apiKey = process.env.EBIRD_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'EBIRD_API_KEY environment variable is not set.' });
  }

  if (!path) {
    return res.status(400).json({ error: 'Missing "path" query parameter.' });
  }

  // Construct the full eBird API URL
  // path will look like "/data/obs/US-ME-019/recent"
  const url = new URL(`https://api.ebird.org/v2${path}`);
  
  // Forward all other query params
  Object.keys(req.query).forEach(key => {
    if (key !== 'path') {
      url.searchParams.append(key, req.query[key]);
    }
  });

  try {
    const response = await fetch(url.toString(), {
      headers: {
        'X-eBirdApiToken': apiKey
      }
    });

    const data = await response.json();
    
    // Add CORS headers for your GitHub Pages domain
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    
    return res.status(response.status).json(data);
  } catch (error) {
    console.error('Proxy Error:', error);
    return res.status(500).json({ error: 'Failed to fetch from eBird API.' });
  }
};
