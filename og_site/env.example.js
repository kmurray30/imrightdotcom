// Copy this file to env.js and add your xAI API key for local development.
// Without a key, the app will fall back to mock data when API calls fail.
window.ENV = Object.assign({}, window.ENV || {}, {
  XAI_API_KEY: "xai-your-key-here"
});
