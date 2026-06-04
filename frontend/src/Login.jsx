import { useState } from 'react';
import './Login.css';

export default function Login({ onLoginSuccess }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const response = await fetch(`${import.meta.env.VITE_SOCKET_URL}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: email, password }),
      });

      if (response.ok) {
        const data = await response.json();
        localStorage.setItem('authToken', data.token);
        
        // Extraemos el nombre antes del @ para usarlo en la sala de espera
        const nombreUsuario = email.split('@')[0]; 
        onLoginSuccess(nombreUsuario); 
      } else {
        setError("Credenciales incorrectas. Verifica tu correo y contraseña.");
      }
    } catch (err) {
      setError("Error de conexión con el servidor. Intenta nuevamente.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="logo-placeholder">
          <span>🏢 Space Town</span>
        </div>
        <h2>Ingresa a tu oficina virtual</h2>
        <p className="subtitle">Acceso exclusivo para el equipo de ARIA IA</p>

        <form onSubmit={handleLogin} className="login-form">
          <div className="input-group">
            <label>Correo Electrónico</label>
            <input 
              type="email" 
              placeholder="ejemplo@ariaia.com" 
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required 
            />
          </div>

          <div className="input-group">
            <label>Contraseña</label>
            <input 
              type="password" 
              placeholder="••••••••" 
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required 
            />
          </div>

          {error && <div className="error-message">{error}</div>}

          <button type="submit" className="signin-btn" disabled={isLoading}>
            {isLoading ? 'Autenticando...' : 'Entrar a la oficina'}
          </button>
        </form>
      </div>
    </div>
  );
}