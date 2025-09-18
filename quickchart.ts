/**
 * QuickChart integration for creating charts via QuickChart.io API
 */

export interface ChartConfig {
  type: 'bar' | 'line' | 'pie' | 'doughnut' | 'scatter' | 'radar';
  data: {
    labels: string[];
    datasets: Array<{
      label?: string;
      data: number[];
      backgroundColor?: string | string[];
      borderColor?: string | string[];
      borderWidth?: number;
    }>;
  };
  options?: {
    title?: {
      display: boolean;
      text: string;
    };
    responsive?: boolean;
    plugins?: any;
    scales?: any;
  };
}

/**
 * Generate a chart URL using QuickChart.io
 */
export async function generateChart(config: ChartConfig): Promise<string> {
  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}`;
}

/**
 * Create a simple chart with default styling
 */
export function createSimpleChart(
  type: ChartConfig['type'],
  data: number[],
  labels: string[],
  title?: string
): ChartConfig {
  const colors = ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40', '#FF8C00', '#8A2BE2'];
  
  return {
    type,
    data: {
      labels,
      datasets: [{
        label: title || 'Data',
        data,
        backgroundColor: type === 'pie' || type === 'doughnut' ? colors.slice(0, data.length) : colors[0],
        borderColor: type === 'line' ? colors[1] : undefined,
        borderWidth: type === 'line' ? 2 : undefined
      }]
    },
    options: {
      title: {
        display: !!title,
        text: title || 'Chart'
      },
      responsive: true,
      ...(type === 'pie' || type === 'doughnut' ? {
        plugins: {
          legend: {
            position: 'right' as const
          }
        }
      } : {})
    }
  };
}

/**
 * Create a multi-dataset chart
 */
export function createMultiDatasetChart(
  type: ChartConfig['type'],
  datasets: Array<{ label: string; data: number[]; color?: string }>,
  labels: string[],
  title?: string
): ChartConfig {
  const defaultColors = ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40'];
  
  return {
    type,
    data: {
      labels,
      datasets: datasets.map((dataset, index) => ({
        label: dataset.label,
        data: dataset.data,
        backgroundColor: dataset.color || defaultColors[index % defaultColors.length],
        borderColor: type === 'line' ? dataset.color || defaultColors[index % defaultColors.length] : undefined,
        borderWidth: type === 'line' ? 2 : undefined
      }))
    },
    options: {
      title: {
        display: !!title,
        text: title || 'Chart'
      },
      responsive: true
    }
  };
}