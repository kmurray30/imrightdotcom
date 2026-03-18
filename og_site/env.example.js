// Copy this file to env.js and add your OpenAI API key for local development.
// Without a key, the app will fall back to mock data when API calls fail.
window.ENV = Object.assign({}, window.ENV || {}, {
  OPENAI_API_KEY: "sk-your-key-here"
});
