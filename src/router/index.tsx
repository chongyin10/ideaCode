import { createHashRouter } from 'react-router-dom'
import App from '../App'
import Home from '../pages/Home'
import About from '../pages/About'
import NotFound from '../pages/NotFound'

const router = createHashRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Home /> },
      { path: 'about', element: <About /> },
      { path: '*', element: <NotFound /> },
    ],
  },
])

export default router
