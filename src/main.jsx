import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { QualityProvider } from './components/quality/QualityProvider.jsx'
import './styles/global.css'

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <QualityProvider>
            <App />
        </QualityProvider>
    </React.StrictMode>,
)
