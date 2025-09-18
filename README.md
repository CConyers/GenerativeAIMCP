# GenerativeAIMCP

> Real-time web search using generative AI responses

## 🎯 Problem Statement

How do we include real-time web searching and generative AI-based responses to prompts within our applications, to ensure output is relevant, useful, up-to-date and able to be verified by a human easily?

### Examples

- **"What was the latest earnings call information for customer X?"**
- **"What are the latest industry trends that impact cloud usage and adoption in industry Y?"**

## 💡 Proposed Solution

A cloud vendor solution that can be used to provide this kind of research and content into our applications.

## 👥 Target Users / Audience

This is the type of feature that can be used to generate relevant sales insights for business applications.

## 📝 Additional Notes

Any other relevant info

## 🚀 Features

- Real-time web search integration via Brave Search MCP server
- Financial data access through AlphaVantage MCP server  
- Interactive chart generation with QuickChart.io
- Recursive conversation flow with clarification handling
- Loop detection to prevent infinite tool calls
- Spinner animations for better user experience

## 🛠️ Technology Stack

- **TypeScript/Node.js** - Core application
- **Gemini 2.0 Flash** - AI model via @ai-sdk/google
- **Model Context Protocol (MCP)** - Server integration
- **QuickChart.io** - Chart generation
- **Inquirer** - Interactive CLI prompts

## 📋 Usage

```bash
npm run client:dev
```

Select from available options:
- **Query** - Ask questions with AI assistance and tool access
- **Tools** - Manually invoke individual tools
- **Resources** - Access MCP server resources
- **Switch Server** - Change between different MCP serversatement:

How do we include real-time web searching and generative AI-based responses to prompts within our applications, to ensure output is relevant, useful, up-to-date and able to be verified by a human easily?

### Examples

- **"What was the latest earnings call information for customer X?"**
- **"What are the latest industry trends that impact cloud usage and adoption in industry Y?"**IMCP

> Real-time web search using generative AI responses

## 🎯 Problem Statement:

How do we include real time web searching and gen AI based responses to prompts within our applications, to ensure output is relevant, useful, up to date and able to be verified by a human easily.

E.g. “What was the latest earnings call information customer X”,

 or 

“what are the latest industry trends that impact cloud usage and adoption in industry Y”.



Proposed Solution:

 A cloud vendors solution that can be used to provide this kind research and content into our applications 

Target Users / Audience: This is the type of feature that can be used to generate relevant sales insights

Additional Notes: Any other relevant info