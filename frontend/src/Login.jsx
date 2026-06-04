import { useState } from 'react';
import './Login.css'; // Crearemos este archivo para que se vea pro

export default function Login({ onLoginSuccess }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleLogin = async (e) => {
    e.preventDefault();
    // Aquí conectas con tu API segura del backend
    const response = await fetch(`${import.meta.env.VITE_SOCKET_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: email, password }),
    });

    if (response.ok) {
      const data = await response.json();
      localStorage.setItem('authToken', data.token); // Almacenamiento seguro
      onLoginSuccess();
    } else {
      alert("Acceso denegado. Credenciales incorrectas.");
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="logo-placeholder">🌐</div>
        <h2>Sign into your office or create an account</h2>
        
        <button className="google-btn" onClick={() => alert("Google Login en desarrollo")}>
          <img src="https://upload.wikimedia.org/wikipedia/commons/c/c1/Google_%22G%22_logo.svg" alt="Google" />
          Continue with Google
        </button>

        <div className="divider">or</div>

        <form onSubmit={handleLogin}>
          <input 
            type="email" 
            placeholder="Enter your email address" 
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required 
          />
          <input 
            type="password" 
            placeholder="Enter your password" 
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required 
          />
          <button type="submit" className="signin-btn">Sign in with email</button>
        </form>
      </div>
    </div>
  );
}