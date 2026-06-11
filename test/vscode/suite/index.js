const path = require('path');
const Mocha = require('mocha');

function run() {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 180000 });
  mocha.addFile(path.join(__dirname, 'callee.test.js'));
  mocha.addFile(path.join(__dirname, 'treeprovider.test.js'));
  mocha.addFile(path.join(__dirname, 'scenarios.test.js'));
  mocha.addFile(path.join(__dirname, 'macro.test.js'));
  mocha.addFile(path.join(__dirname, 'v15.test.js'));
  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { run };
