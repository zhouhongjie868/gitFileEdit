/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./client/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["IBM Plex Sans", "PingFang SC", "Segoe UI", "sans-serif"],
        mono: ["JetBrains Mono", "SFMono-Regular", "monospace"]
      }
    }
  },
  plugins: []
};
