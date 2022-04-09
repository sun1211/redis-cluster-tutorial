const { performance } = require('perf_hooks');

global.logger = console;
global.pMark = name => {
  performance.mark(`s-${name}`);

  return () => {
    performance.mark(`e-${name}`);
    performance.measure(name, `s-${name}`, `e-${name}`);
  };
};
