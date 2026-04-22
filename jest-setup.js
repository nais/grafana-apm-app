// Jest setup provided by Grafana scaffolding
import './.config/jest-setup';

// Combobox from @grafana/ui calls canvas measureText for sizing.
// The scaffolded getContext mock returns {} which lacks measureText.
HTMLCanvasElement.prototype.getContext = () => ({
  measureText: (text) => ({ width: text.length * 8 }),
});
