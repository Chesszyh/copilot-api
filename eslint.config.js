import config from "@echristian/eslint-config"

export default config({
  ignores: ["claude-plugin/**", ".opencode/**", ".claude/**"],
  prettier: {
    plugins: ["prettier-plugin-packagejson"],
  },
})
