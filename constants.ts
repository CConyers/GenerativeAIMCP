
export const SERVER_CONFIGS = [
  {
    name: "Brave Search",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    env: {
      BRAVE_API_KEY: process.env.BRAVE_API_KEY || "",
    },
    type: "stdio",
  },
  {
    name: "Alphavantage",
    url: `https://mcp.alphavantage.co/mcp?apikey=${process.env.ALPHAVANTAGE_API_KEY}`,
    type: "http",
  },
]


export const MCP_RESULT_PROMPT = (
  { query, output }: { query: string; output: string }
) => `
        The user asked: "${query}"

        Here are the search results:
        ${output}

        Please format the final response according to the user’s request.
      `;
export const GOOGLE_MODEL = "gemini-2.5-flash";
