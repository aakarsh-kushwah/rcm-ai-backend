const fs = require('fs');
const path = require('path');

const scriptsDir = path.resolve(__dirname);
const files = fs.readdirSync(scriptsDir);

console.log('Scripts Directory File Listing (Name & Last Modified):');
files.forEach(file => {
  const filePath = path.join(scriptsDir, file);
  const stats = fs.statSync(filePath);
  if (stats.isFile()) {
    console.log(`- ${file.padEnd(35)} | Last Modified: ${stats.mtime.toISOString()}`);
  }
});
