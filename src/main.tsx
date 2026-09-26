import { App } from './App';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 1 },
  },
});

const rootElement = document.querySelector('#root');
if (rootElement === null) {
  throw new Error('The #root element is missing from the page');
}

createRoot(rootElement).render(
  <QueryClientProvider client={queryClient}>
    <App />
    <Toaster
      position="bottom-right"
      richColors
      theme="dark"
    />
  </QueryClientProvider>,
);
