import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Eliminamos las etiquetas <StrictMode> que venían por defecto
createRoot(document.getElementById('root')).render(
  <App />
)