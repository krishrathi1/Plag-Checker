const text = 'hello, which is very long'.repeat(100);
console.log('Testing regex...');
const start = Date.now();
const res = text.replace(/,\s+(which|that|because|while|although)\s+/gi, ". $1 ");
console.log('Regex done in', Date.now() - start, 'ms');
