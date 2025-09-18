/**
 * MCP Tools for chart generation using QuickChart
 */

import { jsonSchema } from "ai";
import { generateChart, createSimpleChart, createMultiDatasetChart } from "./quickchart.js";

export const chartTools = {
  create_chart: {
    description: 'Create a chart with the given data and labels',
    parameters: jsonSchema({
      type: 'object',
      required: ['type', 'data', 'labels'],
      properties: {
        type: { 
          type: 'string', 
          enum: ['bar', 'line', 'pie', 'doughnut', 'scatter', 'radar'], 
          description: 'Chart type' 
        },
        data: { 
          type: 'array', 
          items: { type: 'number' }, 
          description: 'Data values' 
        },
        labels: { 
          type: 'array', 
          items: { type: 'string' }, 
          description: 'Data labels' 
        },
        title: { 
          type: 'string', 
          description: 'Chart title (optional)' 
        }
      }
    }),
    execute: async (args: Record<string, any>) => {
      const chartConfig = createSimpleChart(
        args.type,
        args.data,
        args.labels,
        args.title
      );
      const url = await generateChart(chartConfig);
      return { content: [{ type: 'text', text: `📊 Chart created: ${url}` }] };
    }
  },

  create_multi_dataset_chart: {
    description: 'Create a chart with multiple datasets',
    parameters: jsonSchema({
      type: 'object',
      required: ['type', 'datasets', 'labels'],
      properties: {
        type: { 
          type: 'string', 
          enum: ['bar', 'line', 'scatter', 'radar'], 
          description: 'Chart type (pie/doughnut not supported for multi-dataset)' 
        },
        datasets: {
          type: 'array',
          items: {
            type: 'object',
            required: ['label', 'data'],
            properties: {
              label: { type: 'string', description: 'Dataset label' },
              data: { type: 'array', items: { type: 'number' }, description: 'Dataset values' },
              color: { type: 'string', description: 'Dataset color (optional, hex format)' }
            }
          },
          description: 'Array of datasets with labels and data'
        },
        labels: { 
          type: 'array', 
          items: { type: 'string' }, 
          description: 'X-axis labels' 
        },
        title: { 
          type: 'string', 
          description: 'Chart title (optional)' 
        }
      }
    }),
    execute: async (args: Record<string, any>) => {
      const chartConfig = createMultiDatasetChart(
        args.type,
        args.datasets,
        args.labels,
        args.title
      );
      const url = await generateChart(chartConfig);
      return { content: [{ type: 'text', text: `📊 Multi-dataset chart created: ${url}` }] };
    }
  },

  create_comparison_chart: {
    description: 'Create a side-by-side comparison chart (bar or line)',
    parameters: jsonSchema({
      type: 'object',
      required: ['data1', 'data2', 'labels', 'label1', 'label2'],
      properties: {
        type: { 
          type: 'string', 
          enum: ['bar', 'line'], 
          description: 'Chart type for comparison',
          default: 'bar'
        },
        data1: { 
          type: 'array', 
          items: { type: 'number' }, 
          description: 'First dataset values' 
        },
        data2: { 
          type: 'array', 
          items: { type: 'number' }, 
          description: 'Second dataset values' 
        },
        labels: { 
          type: 'array', 
          items: { type: 'string' }, 
          description: 'Category labels' 
        },
        label1: { 
          type: 'string', 
          description: 'Label for first dataset' 
        },
        label2: { 
          type: 'string', 
          description: 'Label for second dataset' 
        },
        title: { 
          type: 'string', 
          description: 'Chart title (optional)' 
        }
      }
    }),
    execute: async (args: Record<string, any>) => {
      const chartConfig = createMultiDatasetChart(
        args.type || 'bar',
        [
          { label: args.label1, data: args.data1, color: '#FF6384' },
          { label: args.label2, data: args.data2, color: '#36A2EB' }
        ],
        args.labels,
        args.title
      );
      const url = await generateChart(chartConfig);
      return { content: [{ type: 'text', text: `📊 Comparison chart created: ${url}` }] };
    }
  }
};