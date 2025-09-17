export const MCP_RESULT_PROMPT = ({ query, output }) => `
        The user asked: "${query}"

        Here are the search results:
        ${output}

        Please format the final response according to the user’s request.
      `;
