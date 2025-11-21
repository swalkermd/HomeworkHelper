const env = {};
  for (const key of Object.keys(process.env || {})) {
    if (key.startsWith('EXPO_PUBLIC_')) { env[key] = process.env[key]; }
  }
  module.exports = env;
  module.exports.default = env;
  
