import React, { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary';

const publishMock = jest.fn();
jest.mock('@grafana/runtime', () => ({
  getAppEvents: () => ({ publish: publishMock }),
}));

/**
 * Test helper: throws on render when `shouldThrow` is true, otherwise renders
 * its children. Used to exercise the boundary's catch/fallback/recover paths.
 */
function ThrowingComponent({ shouldThrow, message = 'boom' }: { shouldThrow: boolean; message?: string }) {
  if (shouldThrow) {
    throw new Error(message);
  }
  return <div>child content</div>;
}

describe('ErrorBoundary', () => {
  // React logs caught render errors to console.error; silence the noise and
  // let each test assert on the mock explicitly where relevant.
  let consoleErrorSpy: jest.SpyInstance;
  beforeEach(() => {
    publishMock.mockClear();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary label="Test section">
        <ThrowingComponent shouldThrow={false} />
      </ErrorBoundary>
    );
    expect(screen.getByText('child content')).toBeInTheDocument();
  });

  it('renders the fallback (not a crash) when a child throws', () => {
    render(
      <ErrorBoundary label="Test section">
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>
    );
    expect(screen.getByText('Test section failed to load')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByText('child content')).not.toBeInTheDocument();
  });

  it('uses a generic title when no label is given', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>
    );
    expect(screen.getByText('This section failed to load')).toBeInTheDocument();
  });

  it('logs via console.error and publishes an alertError event', () => {
    render(
      <ErrorBoundary label="Test section">
        <ThrowingComponent shouldThrow={true} message="kaboom" />
      </ErrorBoundary>
    );
    // Our own console.error line (React also logs its own separate errors).
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('ErrorBoundary caught an error [Test section]'),
      expect.any(Error)
    );
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: ['Test section failed to load', 'kaboom'],
      })
    );
  });

  it('recovers when Retry is clicked after the cause is fixed', () => {
    function Wrapper() {
      const [shouldThrow, setShouldThrow] = useState(true);
      return (
        <div>
          <button onClick={() => setShouldThrow(false)}>fix</button>
          <ErrorBoundary label="Test section">
            <ThrowingComponent shouldThrow={shouldThrow} />
          </ErrorBoundary>
        </div>
      );
    }
    render(<Wrapper />);
    expect(screen.getByText('Test section failed to load')).toBeInTheDocument();

    // Fix the underlying cause, then Retry to reset the boundary.
    fireEvent.click(screen.getByText('fix'));
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    expect(screen.getByText('child content')).toBeInTheDocument();
    expect(screen.queryByText('Test section failed to load')).not.toBeInTheDocument();
  });

  it('clears the error when a resetKey changes', () => {
    function Wrapper() {
      const [key, setKey] = useState('a');
      const [shouldThrow, setShouldThrow] = useState(true);
      return (
        <div>
          <button
            onClick={() => {
              setShouldThrow(false);
              setKey('b');
            }}
          >
            navigate
          </button>
          <ErrorBoundary label="Test section" resetKeys={[key]}>
            <ThrowingComponent shouldThrow={shouldThrow} />
          </ErrorBoundary>
        </div>
      );
    }
    render(<Wrapper />);
    expect(screen.getByText('Test section failed to load')).toBeInTheDocument();

    fireEvent.click(screen.getByText('navigate'));

    expect(screen.getByText('child content')).toBeInTheDocument();
    expect(screen.queryByText('Test section failed to load')).not.toBeInTheDocument();
  });

  it('isolates a crash to one boundary while siblings keep rendering', () => {
    render(
      <div>
        <ErrorBoundary label="Crashing section">
          <ThrowingComponent shouldThrow={true} />
        </ErrorBoundary>
        <ErrorBoundary label="Healthy section">
          <div>sibling content</div>
        </ErrorBoundary>
      </div>
    );
    expect(screen.getByText('Crashing section failed to load')).toBeInTheDocument();
    expect(screen.getByText('sibling content')).toBeInTheDocument();
  });
});
