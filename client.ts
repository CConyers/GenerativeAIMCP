import "dotenv/config"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { confirm, input, select } from "@inquirer/prompts"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CreateMessageRequestSchema,
  Prompt,
  PromptMessage,
  Tool,
} from "@modelcontextprotocol/sdk/types.js"
import { generateText, jsonSchema, ToolSet, tool } from "ai"

import { GOOGLE_MODEL, MCP_RESULT_PROMPT } from "./constants.js"
import {createSpinner} from "./helper.js"
import { chartTools } from "./chart-tools.js"

const serverConfigs = [
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

const clients: Record<string, Client> = {}
const transports: Record<string, StdioClientTransport | StreamableHTTPClientTransport> = {}

const google = createGoogleGenerativeAI({
  apiKey: process.env.GEMINI_API_KEY,
})

async function main() {
  // Connect to all servers
  for (const config of serverConfigs) {
    const client = new Client(
      {
        name: config.name,
        version: "1.0.0",
      },
      { capabilities: { sampling: {} } }
    )
    let transport: StdioClientTransport | StreamableHTTPClientTransport | undefined
    if (config.type === "stdio") {
        transport = new StdioClientTransport({
          command: config.command ?? "",
          args: config.args,
          env: config.env,
          stderr: "ignore",
        })
    } else if (config.type === "http") {
        transport = new StreamableHTTPClientTransport(
          new URL(config.url!)
        )
    } else {
        throw new Error(`Unknown transport type: ${config.type}`)
    }

    await client.connect(transport)
    clients[config.name] = client
    transports[config.name] = transport
  }

  // Select which server to use
  let selectedServer = await select({
    message: "Select MCP server",
    choices: [
      { name: "Query All Servers", value: "__query_all__" },
      ...serverConfigs.map(cfg => ({ name: cfg.name, value: cfg.name })),
    ],
  })
  // Always set mcp to a valid client (default to first client if needed)
  let mcp: Client = selectedServer === "__query_all__"
    ? clients[Object.keys(clients)[0]]
    : clients[selectedServer]
  // (removed duplicate declaration of mcp)

  let tools: any[] = []
  let prompts: any[] = []
  let resources: any[] = []
  let resourceTemplates: any[] = []

  async function refreshServerData() {
    if (selectedServer === "__query_all__") {
      // Aggregate all tools from all clients
      let allTools: Tool[] = []
      for (const clientName of Object.keys(clients)) {
        try {
          const clientTools = (await clients[clientName].listTools()).tools
          allTools = allTools.concat(clientTools)
        } catch {}
      }

      // Add chart tools to the tools array so they're available regardless of server selection
      const chartToolsAsTools = Object.entries(chartTools).map(([name, tool]) => ({
        name,
        description: tool.description,
        inputSchema: tool.parameters as any,
        annotations: { title: name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) }
      }));
      allTools.push(...chartToolsAsTools);

      tools = allTools
    } else {
      try {
        tools = (await mcp.listTools()).tools
      } catch { tools = [] }
    }
    try {
      prompts = (await mcp.listPrompts())?.prompts ?? []
    } catch { prompts = [] }
    try {
      resources = (await mcp.listResources())?.resources ?? []
    } catch { resources = [] }
    try {
      resourceTemplates = (await mcp.listResourceTemplates())?.resourceTemplates ?? []
    } catch { resourceTemplates = [] }
  }

  await refreshServerData()

  mcp.setRequestHandler(CreateMessageRequestSchema, async request => {
    const texts: string[] = []
    for (const message of request.params.messages) {
      const text = await handleServerMessagePrompt(message)
      if (text != null) texts.push(text)
    }

    return {
      role: "user",
      model: "gemini-2.0-flash",
      stopReason: "endTurn",
      content: {
        type: "text",
        text: texts.join("\n"),
      },
    }
  })

  console.log("You are connected!")
  while (true) {
  const menuChoices = ["Query"]
  if (tools.length > 0) menuChoices.push("Tools")
  if (resources.length > 0 || resourceTemplates.length > 0) menuChoices.push("Resources")
  if (prompts.length > 0) menuChoices.push("Prompts")
  menuChoices.push("Switch Server")
    const option = await select({
      message: `What would you like to do (Server: ${selectedServer})`,
      choices: menuChoices,
    })

  switch (option) {
      case "Switch Server":
        selectedServer = await select({
          message: "Select MCP server",
          choices: [
            { name: "Query All Servers", value: "__query_all__" },
            ...serverConfigs.map(cfg => ({ name: cfg.name, value: cfg.name })),
          ],
        })
        if (selectedServer === "__query_all__") {
          // Aggregate all tools and map to their MCPs
          let allTools: Tool[] = []
          const toolClientMap: Record<string, Client> = {}
          for (const clientName of Object.keys(clients)) {
            try {
              const clientTools = (await clients[clientName].listTools()).tools
              for (const tool of clientTools) {
                allTools.push(tool)
                toolClientMap[tool.name] = clients[clientName]
              }
            } catch {}
          }
          await handleInteractiveQuery(allTools, { multi: true, toolClientMap })
        } else {
          mcp = clients[selectedServer]
          await refreshServerData()
        }
        break
      case "Tools":
        if (!mcp) break;
        const toolName = await select({
          message: "Select a tool",
          choices: tools.map(tool => ({
            name: tool.annotations?.title || tool.name,
            value: tool.name,
            description: tool.description,
          })),
        })
        const tool = tools.find(t => t.name === toolName)
        if (tool == null) {
          console.error("Tool not found.")
        } else {
          await handleTool(tool, mcp)
        }
        break
      case "Resources":
        if (!mcp) break;
        const resourceUri = await select({
          message: "Select a resource",
          choices: [
            ...resources.map(resource => ({
              name: resource.name,
              value: resource.uri,
              description: resource.description,
            })),
            ...resourceTemplates.map(template => ({
              name: template.name,
              value: template.uriTemplate,
              description: template.description,
            })),
          ],
        })
        const uri =
          resources.find(r => r.uri === resourceUri)?.uri ??
          resourceTemplates.find(r => r.uriTemplate === resourceUri)
            ?.uriTemplate
        if (uri == null) {
          console.error("Resource not found.")
        } else {
          await handleResource(uri, mcp)
        }
        break
      case "Prompts":
        if (!mcp) break;
        const promptName = await select({
          message: "Select a prompt",
          choices: prompts.map(prompt => ({
            name: prompt.name,
            value: prompt.name,
            description: prompt.description,
          })),
        })
        const prompt = prompts.find(p => p.name === promptName)
        if (prompt == null) {
          console.error("Prompt not found.")
        } else {
          await handlePrompt(prompt, mcp)
        }
        break
      case "Query":
        if (selectedServer === "__query_all__") {
          // Aggregate all tools and map to their MCPs
          let allTools: Tool[] = []
          const toolClientMap: Record<string, Client> = {}
          for (const clientName of Object.keys(clients)) {
            try {
              const clientTools = (await clients[clientName].listTools()).tools
              for (const tool of clientTools) {
                allTools.push(tool)
                toolClientMap[tool.name] = clients[clientName]
              }
            } catch {}
          }
          // Add chart tools to the aggregated tools
          const chartToolsAsTools = Object.entries(chartTools).map(([name, tool]) => ({
            name,
            description: tool.description,
            inputSchema: tool.parameters as any,
            annotations: { title: name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) }
          }));
          allTools.push(...chartToolsAsTools);
          await handleInteractiveQuery(allTools, { multi: true, toolClientMap })
        } else {
          if (!mcp) break;
          await handleInteractiveQuery(tools, { multi: false, mcp })
        }
    }
  }
}

async function handleTool(tool: Tool, mcp: Client) {
  const args: Record<string, string> = {}
  for (const [key, value] of Object.entries(
    tool.inputSchema.properties ?? {}
  )) {
    args[key] = await input({
      message: `Enter value for ${key} (${(value as { type: string }).type}):`,
    })
  }

  const res = await mcp.callTool({
    name: tool.name,
    arguments: args,
  })

  console.log((res.content as [{ text: string }])[0].text)
}

async function handleResource(uri: string, mcp: Client) {
  let finalUri = uri
  const paramMatches = uri.match(/{([^}]+)}/g)

  if (paramMatches != null) {
    for (const paramMatch of paramMatches) {
      const paramName = paramMatch.replace("{", "").replace("}", "")
      const paramValue = await input({
        message: `Enter value for ${paramName}:`,
      })
      finalUri = finalUri.replace(paramMatch, paramValue)
    }
  }

  const res = await mcp.readResource({
    uri: finalUri,
  })

  console.log(
    JSON.stringify(JSON.parse(res.contents[0].text as string), null, 2)
  )
}

async function handlePrompt(prompt: Prompt, mcp: Client) {
  const args: Record<string, string> = {}
  for (const arg of prompt.arguments ?? []) {
    args[arg.name] = await input({
      message: `Enter value for ${arg.name}:`,
    })
  }

  const response = await mcp.getPrompt({
    name: prompt.name,
    arguments: args,
  })

  for (const message of response.messages) {
    console.log(await handleServerMessagePrompt(message))
  }
}

async function handleServerMessagePrompt(message: PromptMessage) {
  if (message.content.type !== "text") return

  console.log(message.content.text)
  const run = await confirm({
    message: "Would you like to run the above prompt",
    default: true,
  })

  if (!run) return

  const { text } = await generateText({
    model: google(GOOGLE_MODEL),
    prompt: message.content.text,
  })

  return text
}

// Unified interactive query loop (multi or single server). Uses recursive approach for conversation flow.
async function handleInteractiveQuery(tools: Tool[], opts: { multi: boolean; toolClientMap?: Record<string, Client>; mcp?: Client }) {
  const { multi, toolClientMap, mcp } = opts;
  let userQuery = await input({ message: 'Enter your query' });
  let transcript = `User: ${userQuery}`;
  const clarificationRegex = /([?]\s*$)|(specify|clarify|which|provide more details|what (?:interval|format)|please choose|could you (?:specify|clarify|provide)|need more information|please provide|I also need)/i;
  const isClarification = (t: string) => clarificationRegex.test(t.trim());
  const isTooShort = (t: string) => t.split(/\s+/).length < 12;

  // Loop detection to prevent infinite tool calls
  let consecutiveToolCalls = 0;
  let lastToolCall = '';
  const MAX_CONSECUTIVE_TOOL_CALLS = 3;

  const buildToolSet = (): ToolSet => {
    const mcpTools: ToolSet = {};
    
    for (const toolDef of tools) {
      if (toolDef.name in chartTools) {
        // Handle chart tools
        const chartTool = (chartTools as any)[toolDef.name];
        mcpTools[toolDef.name] = tool({
          description: chartTool.description,
          parameters: chartTool.parameters,
          execute: chartTool.execute,
        });
      } else {
        // Handle MCP tools
        mcpTools[toolDef.name] = tool({
          description: toolDef.description,
          parameters: jsonSchema(toolDef.inputSchema as any),
          execute: async (args: any) => {
            const execClient = multi ? toolClientMap![toolDef.name] : mcp!;
            return await execClient.callTool({ name: toolDef.name, arguments: args });
          },
        });
      }
    }
    
    return mcpTools;
  };

  // Recursive function to process conversation steps
  async function processConversation(currentTranscript: string): Promise<void> {
    const spinner = createSpinner('Generating response...');

    const { text, toolResults } = await generateText({ 
      model: google(GOOGLE_MODEL), 
      prompt: currentTranscript, 
      tools: buildToolSet() 
    }) as { 
      text: string; 
      toolResults?: Array<{
        toolName?: string;
        result?: {
          content?: Array<{ text?: string }>;
        };
      }>;
    };
    
    spinner.stop();
    
    // Handle tool results and loop detection
    if (toolResults && toolResults.length > 0) {
      console.log('toolResults :>> ', toolResults);
      const calledToolNames = toolResults
        .map(tr => tr.toolName)
        .filter(Boolean);
      console.log('Tools called:', calledToolNames);
      
      // Check for repeated tool calls (loop detection)
      const currentToolCall = calledToolNames.join(',');
      if (currentToolCall === lastToolCall) {
        consecutiveToolCalls++;
        if (consecutiveToolCalls >= MAX_CONSECUTIVE_TOOL_CALLS) {
          console.log(`⚠️  Detected ${consecutiveToolCalls} consecutive identical tool calls. Forcing final response...`);
          const output = toolResults[0]?.result?.content?.[0]?.text || JSON.stringify(toolResults);
          const { text: forcedText } = await generateText({
            model: google(GOOGLE_MODEL),
            prompt: `${currentTranscript}\n\nTool Results: ${output}\n\nBased on the tool results above, provide a comprehensive final answer. Do not call any more tools.`,
          });
          if (forcedText) {
            console.log(forcedText);
            console.log('--- End of conversation (loop prevented) ---');
            return;
          }
        }
      } else {
        consecutiveToolCalls = 0;
        lastToolCall = currentToolCall;
      }
    }
    
    // If we have tool results but no text, feed results back to Gemini
    if (toolResults?.length && !text) {
      const output = toolResults[0]?.result?.content?.[0]?.text || JSON.stringify(toolResults);
      
      const { text: finalText } = await generateText({
        model: google(GOOGLE_MODEL),
        prompt: MCP_RESULT_PROMPT({ query: currentTranscript, output }),
        tools: buildToolSet()
      });
      
      if (finalText) {
        console.log(finalText);
        const newTranscript = currentTranscript + `\nAssistant: ${finalText}`;
        
        // Check if this final response is a clarification
        if (isClarification(finalText.trim())) {
          const answer = await input({ message: finalText.trim() + ' (/stop to cancel, /run to force answer)' });
          if (answer.toLowerCase() === '/stop') { 
            console.log('--- Conversation aborted ---'); 
            return; 
          }
          const updatedTranscript = newTranscript + `\nUser: ${answer}`;
          if (answer.toLowerCase() === '/run') {
            return processConversation(updatedTranscript + '\nAssistant: Provide the best possible final answer now.');
          }
          return processConversation(updatedTranscript);
        }
        
        // Check if response is too short
        if (isTooShort(finalText.trim())) {
          return processConversation(newTranscript + '\nUser: (auto) Please elaborate fully with data, context, and actionable insights.');
        }
        
        console.log('--- End of conversation ---');
        return;
      }
    }
    
    // Handle case where there's no text at all
    if (!text) {
      return processConversation(currentTranscript + '\nAssistant: Please provide the final comprehensive answer now.');
    }
    
    // Handle normal text response
    const reply = text.trim();
    console.log(reply);
    
    if (isClarification(reply)) {
      const answer = await input({ message: reply + ' (/stop to cancel, /run to force answer)' });
      if (answer.toLowerCase() === '/stop') { 
        console.log('--- Conversation aborted ---'); 
        return; 
      }
      const newTranscript = currentTranscript + `\nAssistant: ${reply}\nUser: ${answer}`;
      if (answer.toLowerCase() === '/run') {
        return processConversation(newTranscript + '\nAssistant: Provide the best possible final answer now.');
      }
      return processConversation(newTranscript);
    }
    
    // Non-clarification -> decide if we should force elaboration
    if (isTooShort(reply)) {
      const newTranscript = currentTranscript + `\nAssistant: ${reply}` + '\nUser: (auto) Please elaborate fully with data, context, and actionable insights.';
      return processConversation(newTranscript);
    }
    
    console.log('--- End of conversation ---');
    return;
  }

  // Start the recursive conversation
  await processConversation(transcript);
}

main()