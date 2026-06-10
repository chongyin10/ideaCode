import { Link } from 'react-router-dom'

function NotFound() {
  return (
    <div style={{ textAlign: 'center', padding: '2rem' }}>
      <h1>404</h1>
      <p>Page not found.</p>
      <Link to="/">Go back home</Link>
    </div>
  )
}

export default NotFound
