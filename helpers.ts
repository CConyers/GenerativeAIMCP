import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { Tool } from "@modelcontextprotocol/sdk/types.js"
import { chartTools } from "./chart-tools.js"
import { jsonSchema, tool } from "ai";

// Helper function to convert chart tools to Tool format
export function getChartToolsAsTools(): Tool[] {
  return Object.entries(chartTools).map(([name, tool]) => ({
    name,
    description: tool.description,
    inputSchema: tool.parameters as any,
    annotations: { title: name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) }
  }));
}

// Helper function to aggregate tools from all servers
export async function aggregateAllTools(clients: Record<string, Client>): Promise<Tool[]> {
  let allTools: Tool[] = []
  for (const clientName of Object.keys(clients)) {
    try {
      const clientTools = (await clients[clientName].listTools()).tools
      allTools = allTools.concat(clientTools)
    } catch {}
  }
  
  // Add chart tools to the aggregated tools
  allTools.push(...getChartToolsAsTools());
  
  return allTools;
}

// Helper function to aggregate tools with client mapping for interactive queries
export async function aggregateToolsWithMapping(clients: Record<string, Client>): Promise<{ allTools: Tool[], toolClientMap: Record<string, Client> }> {
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
  allTools.push(...getChartToolsAsTools());
  
  return { allTools, toolClientMap };
}
export const buildToolSet = ({ tools, multi, toolClientMap, mcp }: { tools: Tool[], multi?: boolean, toolClientMap?: Record<string, Client>, mcp?: Client }): ToolSet => {
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
