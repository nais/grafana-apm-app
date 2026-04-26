// Jest setup provided by Grafana scaffolding
import './.config/jest-setup';

// Combobox from @grafana/ui calls canvas measureText for sizing.
// The scaffolded getContext mock returns {} which lacks measureText.
HTMLCanvasElement.prototype.getContext = () => ({
  measureText: (text) => ({ width: text.length * 8 }),
});

// @grafana/scenes uses IntersectionObserver (LazyLoader) which jsdom lacks.
global.IntersectionObserver = class IntersectionObserver {
  constructor() {}
  observe() {}
  unobserve() {}
  disconnect() {}
};

// StatusBoard uses ResizeObserver for viewport measurement — jsdom lacks it.
global.ResizeObserver = class ResizeObserver {
  constructor() {}
  observe() {}
  unobserve() {}
  disconnect() {}
};
