// Helper function to show a loading spinner
export function createSpinner(message: string = 'Generating response...') {
  const spinnerChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIndex = 0;
  process.stdout.write(`  ${message} `);
  
  const interval = setInterval(() => {
    process.stdout.write(`\r${spinnerChars[spinnerIndex]} ${message}`);
    spinnerIndex = (spinnerIndex + 1) % spinnerChars.length;
  }, 100);
  
  return {
    stop: () => {
      clearInterval(interval);
      process.stdout.write('\r' + ' '.repeat(message.length + 5) + '\r'); // Clear the line
    }
  };
}