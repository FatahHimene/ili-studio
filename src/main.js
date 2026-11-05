// One code base, two servers: MODE=sites runs ili-sites (published websites only), anything else runs ili studio.
if (process.env.MODE === 'sites') await import('./sites.js');
else await import('./server.js');
