import axios from 'axios'

const BASE_URL = import.meta.env.VITE_API_URL || '/api/v1'

export const PLATFORM_TOKEN_KEY = 'platform_token'
export const PLATFORM_USER_KEY = 'platform_user'

const platformApiClient = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
})

platformApiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem(PLATFORM_TOKEN_KEY)
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

platformApiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem(PLATFORM_TOKEN_KEY)
      localStorage.removeItem(PLATFORM_USER_KEY)
      if (!window.location.pathname.startsWith('/platform/login')) {
        window.location.replace('/platform/login')
      }
    }
    return Promise.reject(error)
  },
)

// ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ Types ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬

export type PlatformLoginResponse = {
  access_token?: string
  token_type?: string
  role?: 'super_admin'
  full_name?: string
  username?: string
  // Present when the password was accepted but more verification is needed.
  challenge_id?: string
  otp_required?: boolean
  password_change_required?: boolean
  otp_destination?: string
  otp_expires_in?: number
  resend_available_in?: number
  resends_remaining?: number
}

export type PlatformOtpMode = 'never' | 'new_device' | 'every_login'
export type PlatformCaptchaMode = 'never' | 'after_failed' | 'new_device' | 'every_login'

export type PlatformLoginOptions = {
  forgot_password_enabled: boolean
  force_first_login: boolean
  new_device_alert: boolean
  otp_mode: PlatformOtpMode
  captcha_mode: PlatformCaptchaMode
}

export type PlatformCaptcha = { captcha_id: string; question: string; expires_in: number }

export type PlatformConfig = {
  environment: 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION'
  app_name: string
  app_version: string
  debug: boolean
}

export type PlatformStats = {
  total_tenants: number
  active_tenants: number
  trial_tenants: number
  suspended_tenants: number
  cancelled_tenants: number
  total_plans: number
  total_super_admins: number
}

export type PlatformTenant = {
  id: number
  name: string
  slug: string
  subdomain: string
  status: 'active' | 'suspended' | 'trial' | 'cancelled'
  maintenance_mode: boolean
  admin_email: string
  admin_name: string
  db_name: string
  user_count?: number | null
  max_users: number
  plan_id?: number | null
  trial_ends_at?: string | null
  normal_login_expiry_minutes: number
  remember_me_expiry_minutes: number
  smtp_host?: string | null
  smtp_port?: number | null
  smtp_user?: string | null
  smtp_use_tls: boolean
  smtp_use_ssl: boolean
  from_email?: string | null
  company_mail?: string | null
  address?: string | null
  street_address?: string | null
  pincode?: string | null
  country?: string | null
  state?: string | null
  city_district?: string | null
  area_locality?: string | null
  forgot_password_enabled: boolean
  password_expiry_enabled: boolean
  password_expiry_days: number
  // Storage
  storage_limit_mb: number
  used_storage: number
  // Billing
  billing_email?: string | null
  billing_status: 'trial' | 'active' | 'past_due' | 'cancelled' | 'free'
  subscription_end_date?: string | null
  billing_notes?: string | null
  notes?: string | null
  created_at: string
}

export type PlatformDashboardTenantUserCount = { total_users: number; checked_tenants: number; unavailable_tenants: number }
export type PlatformDiskVolume = { mount: string; percent: number; used_gb: number; total_gb: number }
export type PlatformServerMetrics = { reachable?: boolean | null; available: boolean; error?: string; hostname?: string; cpu_percent?: number; cpu_count?: number; memory_percent?: number; memory_used_gb?: number; memory_total_gb?: number; disk_percent?: number | null; disk_used_gb?: number | null; disk_total_gb?: number | null; disk_mount?: string | null; disk_volumes?: PlatformDiskVolume[]; uptime_seconds?: number }
export type PlatformServerDatabase = { status: 'Healthy' | 'Degraded' | 'Down'; reachable: boolean; error?: string; version?: string; latency_ms?: number; connections?: number; max_connections?: number; uptime_seconds?: number | null; slow_queries?: number | null }
export type PlatformServer = { name: string; ip: string; roles: string[]; status: 'Online' | 'Offline'; metrics: PlatformServerMetrics; database: PlatformServerDatabase | null; tenant_count: number }
export type PlatformTenantPlacement = { id: number; name: string; slug: string; db_name: string; server: string | null; db_status: 'Available' | 'Missing' | 'Unreachable'; db_size_mb: number | null; status: 'active' | 'suspended' | 'trial' | 'cancelled' }
export type PlatformRegionStatus = { region: string; servers: string[]; status: 'Operational' | 'Degraded' | 'Down'; clusters: number; tenants: number; latency_ms: number | null; uptime_30d: number | null }
export type PlatformInfrastructure = { generated_at: string; mode: 'single' | 'multi'; servers: (PlatformServer & { region: string; uptime_30d: number | null })[]; tenants: PlatformTenantPlacement[]; regions: PlatformRegionStatus[]; uptime_tracked_minutes: number }
// ─── Tenants & Hierarchy ────────────────────────────────────────────────────
export type ParentVisibility = 'full' | 'reports' | 'none'
export type HierarchyTenantRow = {
  kind: 'tenant'; id: number; name: string; slug: string; subdomain: string; type: 'company' | 'standalone'
  parent_group_id: number | null; parent_name: string | null; parent_visibility: ParentVisibility; shared_masters: boolean; inherit_parent_policies: boolean
  plan_id: number | null; plan_name: string | null; industry: string | null; color: string | null; db_name: string; server: string | null
  db_size_mb: number | null; db_available: boolean; users: number | null; active_users?: number | null; max_users: number; storage_mb: number; storage_limit_mb: number
  health: number | null; weekly_active: number | null; tender_stages: string[] | null; workspace_url: string | null; mrr: number; status: PlatformTenant['status']; deletion_scheduled_at: string | null; created_at: string
}
export type WorkflowRuleTemplate = { id: number; module: string; action: string; name: string | null; approval_type: string; requester_type: string | null; requester_group_name: string | null; approver_type: string; steps: { step_no: number; approver_type: string; approver_role: string | null; approver_level: number | null }[]; portable: boolean; not_portable_reason: string | null; is_active: boolean }
export type OnboardingStepState = { key: string; label: string; kind: 'automatic' | 'manual'; enabled: boolean; done: boolean; complete: boolean; completed_at: string | null; completed_by: string | null; note: string | null }
export type OnboardingPipeline = {
  steps: { key: string; label: string; kind: 'automatic' | 'manual'; enabled: boolean }[]
  tenants: { id: number; name: string; slug: string; status: string; created_at: string; progress: number; total: number; next_key: string | null; steps: OnboardingStepState[]; next_step: string | null; last_activity: string; live_at: string | null }[]
  kpis: { in_onboarding: number; avg_go_live_days: number | null; go_live_count: number; provisioning_success: number | null; stuck: number }
}
export type ExportOptions = { components: { key: string; label: string }[]; formats: string[]; pii: string[]; encryption: string[]; delivery: string[]; unavailable: Record<string, string> }
export type ExportJobRow = {
  id: number; job: string; components: string[]; format: string; pii: string; encryption: string; delivery: string; link_days: number
  status: 'queued' | 'running' | 'ready' | 'failed' | 'expired'; progress: number; size_bytes: number | null; sha256: string | null
  manifest: { tables: Record<string, number>; files: number; rows: number } | null; requested_by: string | null; error: string | null; created_at: string; completed_at: string | null
  file_sha256: string | null; file_available?: boolean | null; pgp_fingerprint: string | null; attempts: number; expires_at: string | null; estimated_bytes: number | null
}
export type LogLine = { id: number; ts: string; level: 'INFO' | 'WARN' | 'ERROR'; service: string; tenant: string | null; logger: string; message: string; detail: string | null; worker: string }
export type LogsPage = { rows: LogLine[]; matched: number; matched_capped: boolean; has_more: boolean; scoped: boolean
  status: { collecting_since: string | null; latest: string | null; total: number; buffered: number; dropped: number; installed: boolean } | null }
export type JobQueue = { name: string; depth: number; workers: number; rate_per_min: number; failed_24h: number; retries_24h: number; dead_letter: number; oldest_seconds: number | null; paused: boolean }
export type ScheduledJob = { key: string; name: string; schedule: string; running: boolean; last_run_at: string | null; last_status: 'ok' | 'failed' | null; last_duration_ms: number | null
  last_result: string | null; last_error: string | null; next_run_at: string | null; runs_24h: number; failed_24h: number }
export type JobsOverview = {
  generated_at: string; all_scope: boolean; queues: JobQueue[]; scheduled: ScheduledJob[]
  broker: { ok: boolean; url: string; error: string | null }; workers: { ok: boolean; count: number; names: string[]; error: string | null }
  kpis: { queued: number | null; running: number; running_tasks: number | null; running_jobs: number; failed_24h: number; failed_tasks_24h: number | null; failed_jobs_24h: number
    dead_letter: number | null; throughput_per_min: number; tasks_per_min: number | null; job_runs_per_min: number }
}
export type ServiceHealth = 'Healthy' | 'Degraded' | 'Down' | 'Unavailable'
export type InfraService = { name: string; health: ServiceHealth; detail: string; version: string | null; version_source: string | null; replicas: number | null; cpu: number | null; memory: number | null; usage_note: string | null }
export type ReleaseStatus = 'deploying' | 'canary' | 'production' | 'failed' | 'rolled_back' | 'superseded' | 'pending'
export type Release = {
  id: number; version: string; status: ReleaseStatus; rollout_percent: number; previous_version: string | null; operation: 'deploy' | 'promote' | 'rollback' | null
  notes: string | null; config: { canary: boolean; initial_percent: number } | null; verified: boolean; verified_at: string | null; last_error: string | null
  created_by: string | null; created_at: string | null; started_at: string | null; production_at: string | null; ended_at: string | null
  next_percent: number | null; rollback_to: string | null
}
export type ReleaseStep = { id: number; release_id: number; action: 'deploy' | 'promote' | 'rollback'; target_version: string; from_percent: number | null; to_percent: number | null
  status: 'running' | 'succeeded' | 'failed'; trigger: 'manual' | 'auto'; actor: string | null; exit_code: number | null; message: string | null; started_at: string | null; finished_at: string | null; output?: string | null }
export type CapacityServer = { server: string; kind: 'disk' | 'database' | null; used_gb: number | null; total_gb: number | null; db_size_gb: number | null; projected_gb: number | null
  growth_gb_per_day: number | null; days_to_full: number | null; history_hours: number; reason: string | null }
export type InfrastructureOverview = {
  generated_at: string; all_scope: boolean; services: InfraService[]
  pipeline: { releases: Release[]; running_version: string; service: { configured: boolean; error: string | null; command?: string }
    canary: { enabled: boolean; initial_percent: number; steps: number[]; auto_rollback: boolean } }
  capacity: { forecast_days: number; servers: CapacityServer[] }
}
export type ChangeType = 'Release' | 'Maintenance' | 'Migration' | 'Security' | 'Freeze'
export type ChangeRow = {
  id: number; code: string; description: string; type: ChangeType; scope: string; window_start: string; window_end: string; risk: string; owner: string | null
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'failed'; approval: string; in_freeze: boolean; approvals_required: number
  approvals: { by: number; name: string | null; at: string; note: string | null }[]; requested_by: string | null; created_at: string | null
  decided_by: string | null; decided_at: string | null; decision_note: string | null; executed_at: string | null; execution_ref: string | null
  approval_request_id: number | null; can_decide: boolean
}
export type ChangesOverview = {
  generated_at: string; changes: ChangeRow[]; types: ChangeType[]; approval_board: boolean; all_scope: boolean
  freeze: { enabled: boolean; active: boolean; start: string | null; end: string | null; periods: { start: string; end: string }[]; changes_inside: number }
}
export type BillingInvoiceRow = { id: number; number: string; tenant_id: number; tenant: string; plan: string | null; cycle: string; period_start: string; period_end: string
  issued_on: string; due_on: string; subtotal: number; tax_amount: number; total: number; status: 'Pending' | 'Paid'; overdue: boolean; paid_on: string | null; payment_ref: string | null }
export type BillingInvoiceLine = { kind: string; description: string; quantity: number; unit_price: number; amount: number; meter: Record<string, unknown> | null; note: string | null }
export type BillingConfig = { cycle: string; prefix: string; due_days: number; tax: string; over_limit: string; overage_prices: { seat: number; storage_gb: number; ai_query: number } }
export type BillingOverview = {
  kpis: { mrr: number; arr: number; outstanding: number; trials: number; paying_tenants: number; pending_invoices: number }
  plans: { id: number; name: string; slug: string; is_active: boolean; price_monthly: number; price_yearly: number; max_users: number; storage_gb: number[]; modules: number; tenants: number }[]
  revenue_by_tenant: { tenant_id: number; name: string; slug: string; mrr: number; source: string | null }[]
  invoices: BillingInvoiceRow[]; config: BillingConfig; all_scope: boolean
}
export type BillingRunItem = { tenant_id: number; tenant: string; cycle: string; period_start: string; period_end: string; plan: string | null; action: 'invoice' | 'skip'; reason?: string
  lines?: BillingInvoiceLine[]; notes?: string[]; price_source?: string; subtotal?: number; tax_rate?: number; tax_amount?: number; total?: number }
export type EntitlementState = 'on' | 'off' | 'partial' | 'always'
export type EntitlementsOverview = {
  plans: { id: number; name: string; is_active: boolean; price_monthly: number; tenants: number }[]
  modules: (EntitlementModuleInfo & { plans: Record<string, { state: EntitlementState; on: number; of: number }> })[]
  flags: FeatureFlag[]; all_scope: boolean
}
/** One tenant module as Plans & Entitlements lists it – the same names and sidebar order the tenant app uses. */
export type EntitlementModuleInfo = {
  key: string; name: string; sub_modules: string[]; always_on: boolean; is_active: boolean; dependencies: string[]
  /** set when the module ships with another module's feature (e.g. Forecasts with Leads) */
  bundled_with: string | null; bundled_with_name?: string | null
  section: string; section_label: string; custom: boolean
}
export type EntitlementModule = EntitlementModuleInfo & { feature_ids: number[] }
export type FeatureFlag = { key: string; name: string; description: string; rollout_percent: number; tenants_on: number; tenants: number; updated_by: string | null; updated_at: string | null }
export type EntitlementResult = { changed: boolean; state: EntitlementState; applied: { id: number; name: string }[]; unchanged: string[]; failed: { id: number; name: string; error: string }[] }
export type WorkflowStage = { position: number; name: string; kind: 'open' | 'won' | 'lost'; sla_days: number; gate: 'None' | 'Approval' | 'Checklist'; owner_role: string | null; checklist: string[] }
export type WorkflowTemplate = { id: number; key: string; name: string; tenants: number; stages: WorkflowStage[] }
export type WorkflowTenantOption = { id: number; name: string; status: string; template: string | null }
export type WorkflowPushResult = { tenant: { id: number; name: string }; template: { id: number; name: string }; previous_template: string | null; revision: number; records: number; records_moved: number; moved: { from: string; to: string; records: number }[] }
export type SecurityUnavailable = { available: boolean; reason: string | null }
export type SecurityOverview = {
  compliance: { in_force: number; total: number; percent: number | null; categories: string[] }
  frameworks: { name: string; key: string; enabled: boolean }[]
  dsr: SecurityUnavailable & { items: { id: string; tenant: string; type: string; due: string }[] }
  vulnerabilities: SecurityUnavailable
  encryption: SecurityUnavailable & { keys: { key: string; rotated: string | null; next: string | null }[] }
  impersonation: SecurityUnavailable & { items: { staff: string; tenant: string; reason: string; date: string }[] }
}
export type Paged<T> = { items: T[]; total: number; offset: number; limit: number }

// Cost & margin (platform_finops): money is INR per month, excluding GST.
export type FinopsCat = 'compute' | 'database' | 'storage' | 'ai' | 'egress' | 'support'
export type FinopsDiscountKind = 'coupon' | 'volume' | 'negotiated' | 'partner' | 'annual'
export type FinopsRow = Record<FinopsCat, number> & {
  id: number; name: string; slug: string; status: string; billing_status: string | null; paying: boolean
  total: number; subscription: number; addons: number; mrr: number; discount: number; net_mrr: number; profit: number; margin: number | null
  discounts: Record<FinopsDiscountKind, number>; discount_lines: { kind: FinopsDiscountKind; label: string; monthly: number }[]
  partner: { reseller: string; pct: number } | null; cycle: string | null
  usage: { api: number; db_mb: number; storage_mb: number; ai: number; egress_mb: number; tickets: number }
}
export type FinopsPage = Paged<FinopsRow> & { totals: Record<FinopsCat | 'total' | 'mrr' | 'discount' | 'net_mrr' | 'profit', number> & { margin: number | null } }
export interface FinopsSaving {
  key: string; title: string; saving: number | null; gb: number; saving_note: string | null
  action: { kind: 'storage_policy'; policy: string; label: string }; enabled: boolean; unavailable: string | null
}
export interface FinopsOverview {
  month: string; computed_at: string; tenants: number; all_scope: boolean
  kpis: { cost: number; original_mrr: number; discount: number; net_mrr: number; profit: number; margin: number | null; margin_change: number | null
    avg_cost: number | null; budget: number; budget_used: number | null; budget_alert: boolean }
  mix: { key: FinopsCat; label: string; value: number }[]
  discounts: { key: FinopsDiscountKind; label: string; value: number }[]
  trend: { labels: string[]; cost: (number | null)[]; net_revenue: (number | null)[]; original_revenue: (number | null)[]; discount: (number | null)[]; since: string | null }
  sources: { servers: { name: string; region: string | null; monthly_cost: number; rule: string; split: Partial<Record<FinopsCat, number>> }[]; unpriced: string[]
    basis: Record<FinopsCat, 'measured' | 'even' | 'none' | 'unallocated'>; db_errors: string[]
    rates: { storage_gb: number; cold_gb: number; ai_question: number; egress_gb: number; support_month: number } }
  savings: FinopsSaving[]
}
export type TsCase = { id: number; ref: string; title: string; category: string; severity: string; status: string; tenant_id: number | null; tenant: string | null; source: string; opened_at: string; evidence: number; assigned_to: string | null; closed_at: string | null }
export type TsCaseDetail = TsCase & { legal_hold: boolean; timeline: { event: string; actor: string; at: string }[]
  evidence_items: { id: number; kind: string; description: string; sha256: string | null; legal_hold: boolean; created_by: string; created_at: string; export: { id: number; status: string; error: string | null } | null }[] }
export type TsPolicy = { key: string; name: string; action: string; category: string; enabled: boolean; queues: string[]; escalates: boolean; unsupported: string | null; updated_by: string | null }
export type TsUser = { tenant_id: number; tenant: string; tenant_slug: string; id: number; name: string; email: string; role: string; mfa: boolean; last_active: string | null; status: 'Active' | 'Suspended' | 'Terminated' }
export type TsHistory = { id: number; at: string; action: string; target: string; reason: string | null; by: string; case_id: number | null }
export type TsOverview = {
  kpis: { open: number; critical: number; users_terminated_90d: number; users_suspended: number | null; tenants_suspended: number; avg_resolution_days: number | null }
  cases: Paged<TsCase>; policies: TsPolicy[]; users: Paged<TsUser> & { suspended: number; unreachable: string[] }; history: Paged<TsHistory>
  options: { categories: string[]; severities: string[]; user_reasons: string[]; tenant_reasons: string[]; grace_days: number }
  tenants: { id: number; name: string; slug: string; status: string; deletion_scheduled_at: string | null }[]; all_scope: boolean
}
export type TsTerminateResult = { name: string; email: string; evidence_id: number; evidence_sha256: string; revoked: Record<string, number | string> | null; transferred: Record<string, number>; blocked: { domain: string | null; devices: number }; notified?: { sent: boolean; detail: string } }
export type AuditTrailRow = { id: number; at: string | null; actor: string; actor_username: string | null; event: string; action: string; ip: string | null; result: 'Success' | 'Failed' | 'Blocked'; tenant: string | null; tenant_id: number | null; resource_type: string | null; resource: string | null }
export type AuditTrailEntry = Omit<AuditTrailRow, 'tenant_id'> & { actor_email: string | null; resource_id: number | null; old_data: unknown; new_data: unknown }
export type AuditTrailQuery = { offset: number; limit: number; q: string; quick: string; conds: string; logic: 'AND' | 'OR'; sort: string }
export type SupportTicket = { id: number; ref: string; tenant_id: number; tenant: string | null; subject: string; priority: 'Critical' | 'High' | 'Medium' | 'Low'; status: string; requester: string | null; created_at: string; closed_at: string | null
  sla?: { code: 'P1' | 'P2' | 'P3'; breached: boolean; next_due: string | null; next: string | null } | null }
// SLA & customer satisfaction (Governance): hours are SLA targets; times are UTC ISO strings
export type SlaTarget = { due: string; at: string | null; state: 'met' | 'breached' | 'running'; left_secs?: number }
export type TicketDetail = SupportTicket & { description: string | null; requester_email: string | null
  replies: { id: number; kind: 'staff' | 'tenant'; author: string | null; body: string; at: string }[]
  sla: { priority: string; coverage: string; policy: { version: number; first_response_h: number; resolution_h: number; coverage: string; channels: string[] } | null
    first_response: SlaTarget; resolution: SlaTarget } | null
  csat: { rating: number; feedback: string | null; by: string | null; channel: string; at: string } | null }
export type SlaPolicy = { plan_id: number; plan: string; active: boolean; first_response_h: number; resolution_h: number; coverage: 'business' | '24x7_p1' | '24x7'
  channels: string[]; coverage_label: string; channels_label: string; version: number | null; updated_by: string | null; updated_at: string | null }
export type SlaCalendar = { days: number[]; day_start: string; day_end: string; holidays: { date: string; name: string }[]; timezone: string; updated_by: string | null; updated_at: string | null }
export type CannedResponse = { id: number; key: string; title: string; body: string }
export interface SlaOverview {
  kpis: { tickets: number; sla_met: number | null; met: number; known: number; sla_spark: (number | null)[]; avg_first_response_h: number | null; first_responses: number
    avg_resolution_h: number | null; resolutions: number; csat: number | null; csat_responses: number; breaches: number; first_breaches: number; resolution_breaches: number }
  policies: SlaPolicy[]
  csat: { labels: string[]; months: string[]; values: (number | null)[]; responses: number[] }
  breaches: { code: string; label: string; breaches: number; first_response: number; resolution: number }[]
  canned: CannedResponse[]; calendar: SlaCalendar; coverage: Record<string, string>; channels: Record<string, string>; all_scope: boolean
}
export type Announcement = { id: number; title: string; audience: string; audience_label: string; recipients: number; tenants: number; failed: { tenant: string; error: string }[]; sent_by: string | null; sent_at: string }
// Add-ons & usage pricing (Business)
export type AddonRow = { id: number; name: string; price: number; unit: string; status: 'Draft' | 'Active' | 'Beta' | 'Paused'; tenants: number; mrr: number }
export type UsageTable = { metric: string; label: string; unit: string; metered: boolean; source: string; since: string | null
  rows: { plan_id: number; plan: string; included: number | null; price: number | null; example: number | null; effective_from: string | null }[] }
export type TrialSettings = { trial_days: number; extension_days: number; auto_convert: boolean; convert_plan_id: number | null; convert_plan: string | null
  require_card: boolean; seed_sample: boolean; status: Record<'require_card' | 'auto_convert' | 'seed_sample', string> }
export type PriceBooks = { plans: { id: number; name: string; per_seat_inr: number; max_users: number }[]
  rows: { currency: string; symbol: string; rate: number | null; effective_from: string | null; upcoming: { rate: number; effective_from: string } | null; seats: (number | null)[]; tax: string }[] }
export type AddonsOverview = {
  kpis: { addons: number; addon_mrr: number; tenants_with_addons: number; overage_month: number; overage_month_label: string; overage_month_closed: boolean }
  addons: AddonRow[]; usage: UsageTable[]; trials: TrialSettings; price_books: PriceBooks; plans: { id: number; name: string }[]; all_scope: boolean
}
export type TenantAddon = { addon_id: number; name: string; price: number; unit: string; status: string; active: boolean; quantity: number; since: string | null }
// Invoices & dunning (Business)
export type InvoiceStatus = 'Paid' | 'Due' | 'Overdue' | 'Failed' | 'Credited'
export type InvoiceRow = { id: number; number: string; tenant_id: number; tenant: string; period: string; period_start: string; period_end: string; issued_on: string
  total: number; tax: number; due_on: string; gateway: string | null; status: InvoiceStatus; balance: number; paid: number; credited: number; creditable: number; failure: string | null }
export type GatewayKey = 'razorpay' | 'stripe' | 'bank' | 'upi' | 'manual' | 'wallet'
export type GatewayCard = { key: GatewayKey; name: string; description: string; enabled: boolean; configured: boolean; status: 'Connected' | 'Available' | 'Off' | 'Not configured' | 'Not verified' | 'Verification failed'
  detail: string | null; verified_at: string | null; webhook: string | null; can_verify: boolean }
export type InvoicingOverview = {
  kpis: { invoiced_month: number; invoices_month: number; collected_month: number; due: number; overdue: number; at_risk_tenants: number }
  dunning: { steps: { key: string; day: number; text: string; on: boolean }[]; policy: { grace_days: number; max_retries: number; suspend_after: number; late_fee_pct: string; pause_on_plan: boolean }
    notes: Record<'retry' | 'readonly' | 'suspend', string> }
  gst: { gstin: string; sac: string; rate: number; supply: string; rates: number[]; supply_options: Record<string, string>; tax_on: boolean; problem: string | null }
  einvoice: { irn: boolean; cancel_irn: boolean; gstn_24h: boolean; tds_reminder: boolean; configured: boolean; detail: string }
  gateways: GatewayCard[]
  credit_notes_enabled: boolean
  payment_plans: { id: number; tenant_id: number; tenant: string; until: string; note: string; approved_by: string | null }[]
  all_scope: boolean
}
export type CreditNoteRow = { id: number; number: string; tenant_id: number; tenant: string; invoice: string; amount: number; tax: number; reason: string; status: string; issued_at: string; issued_by: string | null }
export type CreditableInvoice = { id: number; number: string; tenant: string; total: number; creditable: number; status: InvoiceStatus }
export type InvoiceListQuery = { offset: number; limit: number; q: string; quick: string; conds: string; logic: 'AND' | 'OR'; sort: string }
// Discounts & coupons (Business)
export type CouponRow = { id: number; code: string; kind: 'percent' | 'amount'; value: number; duration: string; duration_label: string; plan_ids: number[] | null
  applies_to: string; limit: number; redeemed: number; valid_until: string; status: 'Active' | 'Paused' | 'Expired' | 'Exhausted'; paused: boolean; note: string | null }
export type NegotiatedDiscount = { id: number; tenant_id: number; tenant: string; pct: number; term: string; valid_until: string | null; reason: string; requested_by: string | null
  requested_by_id: number | null; requested_at: string; status: string; status_key: 'pending' | 'active' | 'rejected' | 'ended'; decided_by: string | null; decided_at: string | null
  history: { at: string; by: string; action: string; note: string | null }[] }
export type DiscountsOverview = {
  kpis: { active_coupons: number; redemptions: number; redemptions_trend: number[]; mrr_discount: number; avg_discount: number | null; awaiting_approval: number; paying_tenants: number }
  coupons: { items: CouponRow[]; total: number; offset: number; limit: number }
  redemptions_by_coupon: { code: string; count: number }[]
  discount_by_plan: { plan: string; amount: number }[]
  volume_tiers: { id: number; from: number; to: number | null; pct: number }[]
  settings: Record<string, number | boolean>
  setting_notes: Record<string, string | null>
  negotiated: NegotiatedDiscount[]
  approvals: NegotiatedDiscount[]
  reseller_tiers: { tier: string; min_arr: number; margin: number; resellers: { name: string; arr: number }[] }[]
  plans: { id: number; name: string }[]
  tenants: { id: number; name: string }[]
  me: number | null; all_scope: boolean
}
export type TenantDiscounts = {
  plan: string | null; cycle: string; seats: number; list_mrr: number; effective_mrr: number; paying: boolean
  volume_tier: { from: number; to: number | null; pct: number } | null
  negotiated: NegotiatedDiscount[]
  redemptions: { code: string; kind: string; value: number; duration: string; status: string; redeemed_at: string; redeemed_by: string | null }[]
  eligible_coupons: string[]
}
// Regions & capacity (Data & infrastructure)
export type RegionRow = {
  region: string; city: string | null; residency: string | null; shards: number; servers: string[]; utilisation: number | null; utilisation_source: string | null
  per_server: { server: string; utilisation: number | null; database: boolean }[]; tenants: number; latency_ms: number | null; latency_source: string | null
  cost: number | null; status: 'Healthy' | 'Degraded' | 'Down' | 'Planned'; planned: boolean; in_config?: boolean
  provision?: { available: boolean; reason: string | null }; failover: { available: boolean; reason: string | null }
  last_failover: { at: string; passed: boolean; summary: string } | null
}
export type RegionsOverview = {
  kpis: { regions_live: number; db_shards: number; avg_utilisation: number | null; monthly_cost: number | null; shards_above_80: number }
  regions: RegionRow[]
  forecast: { labels: string[]; series: { region: string; measured: (number | null)[]; projected: (number | null)[] | null; growth_pct_per_month: number | null; history_hours: number }[]; notes: string[]; now_index: number }
  add_region: { available: boolean; next: string | null; reason: string | null }
  generated_at: string
}
export type FailoverTestResult = {
  passed: boolean; summary: string; checks: { server: string; primary: string | null; lag_seconds: number | null; passed: boolean; problems: string[] }[]
  backups: { tenants: number; problems: string[] }
}
// Environments & sandboxes (Data & infrastructure)
export type SandboxSource = 'masked' | 'full' | 'template' | 'empty'
export type SandboxRow = {
  id: number; name: string; tenant_id: number; tenant: string; source: string; source_key: SandboxSource; size_mb: number | null; created_at: string; expires_at: string
  status: 'Provisioning' | 'Active' | 'Refreshing' | 'Failed'; progress: string | null; error: string | null; database: string; masking_verified: boolean; expires_in_days: number
}
export type ChangeSetRow = {
  id: number; code: string; contents: string; tenant: string; from_sandbox: string; items: number; status: string; status_key: string; error: string | null
  approval_request_id: number | null; promoted_at: string | null; promoted_by: string | null; can_rollback: boolean
}
export type EnvironmentsOverview = {
  kpis: { sandboxes: number; storage_mb: number; pending_change_sets: number; expiring_14d: number }
  environments: { items: SandboxRow[]; total: number; offset: number; limit: number }
  change_sets: { items: ChangeSetRow[]; total: number; offset: number; limit: number }
  tenants: { id: number; name: string }[]
  defaults: { days: number }
}
// Announcements & maintenance (Command)
export type AnnouncementType = 'Info' | 'Important' | 'Maintenance'
export type FeedAnnouncement = {
  id: number; title: string; message: string; type: AnnouncementType; posted_by: string | null; posted_at: string; until: string | null; live: boolean
  audience: string; tenants: number; recipients: number; reads: number; read_rate: number | null; failed: { tenant: string; error: string }[]; maintenance_change_id: number | null
}
export type MaintenanceWindow = { id: number; code: string; title: string; when: string; scope: string; status: string; starts_at: string | null; ends_at: string | null }
export type AnnouncementsOverview = {
  kpis: { live: number; users_reached: number; avg_read_rate: number | null; upcoming_maintenance: number }
  announcements: { items: FeedAnnouncement[]; total: number; offset: number; limit: number }
  maintenance: MaintenanceWindow[]
  tenants: { id: number; name: string }[]
  scopes: { key: string; label: string }[]
  all_scope: boolean
}
export type SupportOverview = { tickets: Paged<SupportTicket>; announcements: Announcement[]; tenants: { id: number; name: string }[]; all_scope: boolean }
export type WebhookDelivery = { id: number; tenant: string; event: string; status: 'Done' | 'Failed' | 'Retrying' | 'Pending'; latency_ms: number | null; attempts: number; response_code: number | null; error: string | null; at: string }
export type ApiWebhooksOverview = {
  kpis: { api_requests_24h: number; webhook_deliveries_24h: number; delivery_success: number | null; delivered: number; failed: number; rate_limited: number | null; rate_limited_requests: number }
  rate_limits: { plan_id: number; plan: string; per_minute: number; burst: number; updated_by: string | null }[]
  deliveries: Paged<WebhookDelivery>; tenants: { id: number; name: string }[]; events: string[]; all_scope: boolean
}
export type CreatedApiKey = { id: number; name: string; prefix: string; tenant: string; user_id: number; key: string; scopes: string[]; rate_limit: { per_minute: number; burst: number; daily_cap: number }; note: string }
// Rate limits & API keys (Platform admin)
export type PlanRateLimit = { plan_id: number; plan: string; per_minute: number; burst: number; daily_cap: number; updated_by: string | null; updated_at: string | null }
export type ApiVersionRow = { version: string; status: 'Current' | 'Deprecated' | 'Beta'; sunset: string | null; implemented: boolean; requests: number | null; traffic: number | null; updated_by: string | null }
export type ApiKeyRow = { id: number; tenant_id: number; tenant: string | null; name: string; key: string; scopes: string[]; user_id: number; created: string; created_by: string | null
  last_used: string | null; status: 'Active' | 'Rotate soon' | 'Revoked'; expires_at: string | null; revoked_at: string | null; revoked_by: string | null; replaced_by_id: number | null }
export interface RateLimitsOverview {
  kpis: { api_calls_24h: number; api_spark: number[]; throttled_requests: number; throttled_pct: number | null; active_keys: number; keys_older_90d: number; p95_ms: number | null; p95_scope: string }
  plans: PlanRateLimit[]; versions: ApiVersionRow[]; overlap_hours: number; rotate_after_days: number; all_scope: boolean
}
export type Reseller = { id: number; name: string; region: string | null; tier: string; commission: number; tenants: number; domain: string; earned: number; created_at: string }
export type ResellersOverview = { kpis: { resellers: number; tenants_via_resellers: number; commission_payable: number; avg_commission: number | null }; resellers: Reseller[]; tenants: { id: number; name: string; reseller: string | null }[]; tiers: string[]; all_scope: boolean }
export type MobileRelease = { id: number; version: string; platform: 'iOS' | 'Android'; channel: string; rollout: number; status: string; min_supported: string | null; notes: string | null; created_at: string }
export type MobileTenant = { id: number; name: string; enabled: boolean; roles: Record<'admin' | 'ceo' | 'manager' | 'kam', boolean>; offline: boolean; gps: boolean; voice: boolean; biometric: boolean
  screenshots_blocked: boolean; device_approval: boolean; max_devices: number; app_name: string; distribution: 'Shared app' | 'Branded app'; bundle_id: string; colour: string | null; enterprise: boolean }
export type MobileDevice = { id: number; tenant_id: number; tenant: string; user_id: number; user: string | null; model: string | null; os: string | null; platform: string | null; app_version: string | null; integrity: string | null; last_seen: string | null; status: string; source: string }
export type MobilePolicy = { key: string; label: string; type: 'sw' | 'num'; value: boolean | number; enforcement: 'app' | 'server_if_reported' }
export type MobilePush = { id: number; title: string; audience: string; when: string; status: string; sent: number; accepted: number; failed: number; delivered_pct: number | null; error: string | null; date: string; scheduled_for: string | null }
export type MobileProvider = { name: string; status: string; detail: string }
export type MobileOverview = {
  kpis: { registered: number; active_7d: number; crash_free: number | null; latest_version: string | null; on_latest: number | null; versions_reported: number; push_24h: number; push_rate: number | null; flagged: number }
  versions: { l: string; v: number }[]; platforms: { l: string; v: number }[]; dau: { labels: string[]; values: number[] }; usage: { l: string; v: number }[]; unreachable: string[]
  active_devices: number; releases: MobileRelease[]; settings: { min_supported: Record<string, string | null>; soft_prompt: boolean; blocked: { version: string; platform: string }[] }
  policy: MobilePolicy[]; tenants: MobileTenant[]; all_scope: boolean; audiences: Record<string, string>; when: string[]
}
export type CsFactor = 'usage' | 'adoption' | 'support' | 'billing' | 'nps'
export type CsRow = {
  id: number; name: string; slug: string; status: string; health: number | null; risk: 'High' | 'Medium' | 'Low' | null; missing: string[]
  factors: Record<CsFactor, number | null>; notes: Record<CsFactor, string>; adoption: Record<string, { pct: number | null; users?: number; note: string }>
  arr: number; renewal: string | null; renewal_kind: string | null; data_error: string | null
}
export type CsPlaybook = { key: string; title: string; actions: string; enabled: boolean }
export type CsOverview = {
  kpis: { avg_health: number | null; scored: number; tenants: number; at_risk: number; arr_at_risk: number; nps: number | null; renewals_90d: number; renewals_trial: number }
  tenants: Paged<CsRow>; model: { key: CsFactor; label: string; weight: number }[]; min_weight: number; targets: Record<string, number>
  modules: string[]; playbooks: CsPlaybook[]; email_enabled: boolean; cache_seconds: number; all_scope: boolean
}
export type CsRunResult = { run_id: number; outcome: 'success' | 'partial' | 'failed' | 'no_matches'; matched: number; tenants: number; done: number; failed: number; already_done: number; not_sent: number
  results: { tenant_id: number; tenant: string; rule: string; action: string; status: string; detail: string }[] }
export type RevenueWindow = { since: string; truncated: boolean }
export type RevenueOverview = {
  mrr: number; arr: number; paying_accounts: number; trials: number; arpa: number | null; ltv_cac: number | null; ltv_cac_reason: string
  plans: { plan: string; mrr: number; accounts: number }[]; ledger_start: string | null; now: string; mrr_change: number | null; trend: number[]
  movement: (RevenueWindow & { start: number; new: number; expansion: number; contraction: number; churn: number; end: number; accounts: Record<'new' | 'expansion' | 'contraction' | 'churn', number> }) | null
  nrr: (RevenueWindow & { value: number | null; start_mrr: number; accounts: number }) | null
  churn: (RevenueWindow & { value: number | null; lost: number; accounts: number }) | null
  cohorts: { months: string[]; rows: { label: string; accounts: number; cells: ({ pct: number; retained: number; eligible: number } | null)[] }[]; paying_at_baseline: number }
  all_scope: boolean
}
export type MarketApp = {
  id: number; name: string; publisher: string; category: string; installs: number; rating: number | null; scopes: string[]
  security: { label: string; level: string; code_scanned: boolean; scope_review: string; scope_findings: string[]; scan_result: string | null; scanned_at: string | null }
  status: string; status_reason: string | null; price_monthly: number; private: boolean
}
export type MarketOverview = {
  kpis: { live: number; in_review: number; installs: number; suspended: number; revenue_share_30d: number | null }
  apps: Paged<MarketApp>; plans: { plan_id: number; plan: string; access: string; max_installs: number | null; label: string }[]
  policy: { key: string; label: string; enabled: boolean }[]; scanner_connected: boolean; all_scope: boolean
}
export type ExportVerify = { package_sha256: string; file_sha256: string; file_ok: boolean | null; package_ok: boolean | null; verified: boolean }
export type MigrationDataset = { key: string; name: string; kind: string; columns: string[]; rows: number; sample: Record<string, string>[]; target: string | null; suggested: Record<string, string> }
export type MigrationRow = {
  id: number; project: string; source: string; files: string[] | null; datasets: MigrationDataset[]
  mapping: Record<string, { enabled: boolean; target: string | null; fields: Record<string, string> }>
  rules: { dup: string; own: string; ids: boolean; dates: boolean; notes: boolean }
  dry_run: { at: string; totals: { tot: number; ok: number; w: number; e: number; d: number }; objects: { dataset: string; target: string; records: number; warnings: number; errors: number; duplicates: number; top_issue: string }[] } | null
  result: { created: Record<string, number[]>; updated: Record<string, number>; skipped: number; errors: number } | null
  status: string; progress: number; records: number | null; created_by: string | null; error: string | null; created_at: string; completed_at: string | null; rollback_until: string | null
  scheduled_at: string | null; pull: { objects: string[]; done: Record<string, number> } | null; checkpoint: number | null; can_rollback: boolean
}
export type MigrationConnector = {
  source: string; kind: 'api' | 'file'; method: string; objects: { name: string; count: number | null; error?: string }[]
  fields: { key: string; label: string; secret: boolean; value: string | null; set: boolean }[]
  status: 'connected' | 'failed' | 'not_configured' | 'ready'; account: string | null; detail: string | null; validated_at: string | null; updated_by?: string | null
}
export type DataTransferOverview = {
  generated_at: string; all_scope: boolean; tenants: { id: number; name: string; slug: string; status: string }[]
  exports: (ExportJobRow & { tenant: { id: number; name: string; slug: string } })[]
  migrations: (MigrationRow & { tenant: { id: number; name: string; slug: string } })[]
  connectors: MigrationConnector[]
}
export type MigrationOptions = { sources: string[]; file_sources: string[]; connectors: Record<string, { method: string; status: MigrationConnector['status']; account: string | null; detail: string | null; objects: MigrationConnector['objects'] }>; duplicates: string[]; owners: string[]; targets: Record<string, { label: string; fields: { key: string; label: string; required: boolean }[] }> }
export type ControlStatus = 'live' | 'saved' | 'planned' | 'fixed' | 'unsupported'
export type ControlDef = {
  key: string; type: 'sw' | 'sel' | 'num' | 'txt'; label: string; prototype_label: string; default: boolean | number | string
  options: string[]; prototype_options: string[]; status: ControlStatus; note: string | null; dynamic: string | null; platform_only: boolean
}
export type ControlCategory = { id: string; name: string; icon: string; groups: { name: string; controls: ControlDef[] }[] }
export type ControlValue = boolean | number | string
export type ControlValues = {
  platform: Record<string, ControlValue>; overrides: Record<string, ControlValue> | null
  tenant: { id: number; name: string } | null; updated: Record<string, { by: string | null; at: string | null }>
}
export type HierarchyServer = { name: string; ip: string; db_host: string; db_port: number; region: string; status: string | null; databases: number }
export type HierarchyGroupRow = {
  kind: 'group'; id: number; name: string; slug: string; type: 'group'; industry: string | null; color: string | null; plan_id: number | null; plan_name: string | null
  default_visibility: ParentVisibility; notes: string | null; children: number; child_ids: number[]; users: number; storage_mb: number; db_size_mb: number
  mrr: number; status: 'active' | 'suspended'; created_at: string
}
export type TenantGroupDetail = HierarchyGroupRow & { companies: HierarchyTenantRow[] }
export type TenantGroupReport = {
  generated_at: string; record_labels: string[]
  companies: { id: number; name: string; visibility: ParentVisibility; status: string; available: boolean; users: number | null; weekly_active: number | null; active_sessions: number | null; records: Record<string, number>; storage_mb: number; db_size_mb: number | null; mrr: number }[]
  totals: { users: number; weekly_active: number; active_sessions: number; storage_mb: number; db_size_mb: number; mrr: number; records: Record<string, number> }
  excluded: { id: number; name: string; reason: string }[]
}
export type TenantMetrics = { available: boolean; users: number | null; active_users: number | null; weekly_active: number | null; active_sessions: number | null; last_activity: string | null; records: Record<string, number> }
export type TenantOverview = {
  id: number; name: string; slug: string; subdomain: string; status: PlatformTenant['status']; type: 'company' | 'standalone'; parent_group_id: number | null; parent_name: string | null
  industry: string | null; color: string | null; created_at: string; trial_ends_at: string | null; admin_name: string; admin_email: string
  plan: { id: number; name: string; price_monthly: number; max_users: number } | null; db_name: string; server: string | null; server_ip: string | null; region: string | null
  db_size_mb: number | null; db_available: boolean; max_users: number; storage_mb: number; storage_limit_mb: number; metrics: TenantMetrics; health: number | null; mrr: number
  last_backup_at: string | null; deletion_scheduled_at: string | null; maintenance_mode: boolean
}
export type TenantSettingsOverrides = { sections: { title: string; settings: { key: string; label: string; platform_default: unknown; value: unknown; overridden: boolean }[] }[] }
export type TenantDatabaseTable = { name: string; rows: number; data_mb: number; index_mb: number; free_mb: number; updated_at: string | null; engine: string }
export type TenantDatabase = {
  engine: string; version: string; database: string; host: string; port: number; size_mb: number; data_mb: number; index_mb: number; free_mb: number; table_count: number
  connections: number; max_connections: number; pool: string; isolation: string; ssl: string; encryption_at_rest: string; charset: string; replication: string
  restored_databases: string[]; tables: TenantDatabaseTable[]; server: string | null; server_ip: string | null; last_backup_at: string | null
}
export type TenantQueryResult = { columns: string[]; rows: (string | null)[][]; truncated: boolean; ms: number }
export type TenantMonitoring = {
  traffic: { window_seconds: number; requests_per_minute: number; p95_ms: number | null; error_rate: number; apdex: number | null; requests: number; series: { seconds_ago: number; requests_per_min: number }[] }
  active_sessions: number | null; server: string | null; uptime_30d: number | null; uptime_tracked_minutes: number
  availability: { day_start: number; percent: number | null }[]; targets: { p95_ms: number; sla_percent: number }
}
export type TenantBackupRow = { id: number; name: string; status: string; frequency: string | null; created_at: string; completed_at: string | null; next_run_at: string | null; error: string | null; available: boolean; size_mb: number | null }
export type TenantUserRow = { id: number; name: string; email: string; username: string; role: string; is_active: boolean; mfa: boolean; last_login: string | null; last_active: string | null; tenant_id: number; company: string }
export type TenantSecurity = {
  otp_mode: string; captcha_mode: string; force_password_change_on_first_login: boolean; new_device_login_alert_enabled: boolean; forgot_password_enabled: boolean
  password_expiry_enabled: boolean; password_expiry_days: number; inactivity_timeout_minutes: number; otp_modes?: string[]; captcha_modes?: string[]
}
export type TenantConfiguration = { counts: Record<string, number> | null; identity: Record<string, string | number | null> }
export type TenantMeter = { meter: string; used: number | null; included: number | null; unit: string; overage: number }
export type PlatformAuditRow = { id: number; created_at: string; actor?: string; action: string; description: string | null; ip: string | null }

export type PlatformCommandCenterSummary = {
  active_sessions: number
  provisioned_users: number
  unavailable_tenants: number
  mrr: number
  paying_tenants: number
  dead_letter: number | null
  events: { kind: 'deploy' | 'incident' | 'resolved'; text: string; at: number; server?: string }[]
  open_incidents: { server: string; state: string }[]
  targets: { p95_ms: number; error_budget_percent: number; sla_percent: number; cpu_alert_percent: number }
}
export type PlatformCommandCenterLive = {
  window_seconds: number
  requests_per_second: number
  p95_ms: number | null
  error_rate: number
  requests_5m: number
  errors_5m: number
  queue_depth: number | null
  series: { seconds_ago: number; rps: number; p95_ms: number | null }[]
  active_tenants: { id: number; name: string; slug: string; requests_per_minute: number }[]
  attention: { severity: 'critical' | 'warning' | 'info'; message: string; link: string }[]
}
export type PlatformDashboardTenantUsage = { id: number; name: string; status: 'active' | 'suspended' | 'trial' | 'cancelled'; used_storage: number; storage_limit_mb: number }
export type PlatformDatabaseHealth = { health: 'healthy' | 'unavailable'; active_users: number | null; connections: number | null; max_connections: number | null; slow_queries: number | null; checked_at: string }
export type PlatformBackup = { id: number; tenant_id: number; status: string; available: boolean; completed_at: string | null; created_at: string; error: string | null }
export type PlatformSubscriptionState = 'active' | 'trial' | 'expired' | 'renewing'
export type PlatformSubscriptionSummary = {
  generated_at: string; total_subscriptions: number; active: number; trials: number; expired: number; renewals_due: number
  tenants: Array<PlatformTenant & { subscription_state: PlatformSubscriptionState; renewal_date: string | null }>
}
export type TenantStorageUsage = {
  tenant_id: number
  used_mb: number
  limit_mb: number
  used_bytes: number
  file_count: number
  usage_percent: number
}

export type PlanPermissionsPreview = {
  plan_id: number
  plan_name: string
  enabled_feature_keys: string[]
  total_permissions: number
  permissions_by_module: Record<string, Array<{
    key: string
    module: string
    action: string
    description: string
    is_system: boolean
  }>>
}

export type PlatformPlan = {
  id: number
  name: string
  slug: string
  description?: string | null
  price_monthly: number
  price_yearly: number
  max_users: number
  is_active: boolean
  created_at: string
}

export type PlatformFeature = {
  id: number
  key: string
  name: string
  module?: string | null
  description?: string | null
}

export type PlatformService = Omit<PlatformFeature, 'id'> & { id: number | null; parent_id: number | null; parent_key?: string | null; is_active: boolean; feature_key?: string | null; manageable: boolean; dependencies: string[]; configuration_status: 'ready' | 'needs_configuration' | 'not_applicable'; configuration_notes?: string | null; plan_assignments: number; tenant_assignments: number }

export type TenantFeatureItem = {
  id: number
  key: string
  name: string
  module?: string | null
  description?: string | null
  enabled: boolean
}

export type TenantFeaturesResponse = {
  tenant_id: number
  feature_ids: number[]
  features: TenantFeatureItem[]
}

export type PlatformSuperAdmin = {
  id: number
  username: string
  email: string
  full_name: string
  is_active: boolean
  created_at: string
}

export type PlatformAccessLevel = 'none' | 'view' | 'manage'
export type PlatformModule = { key: string; label: string }

export type PlatformTeamMe = {
  role_id: number
  role_key: string
  role_name: string
  is_super_admin: boolean
  permissions: Record<string, PlatformAccessLevel>
  scope: 'all' | 'assigned'
  tenant_ids: number[]
  modules: PlatformModule[]
  four_eyes_enabled: boolean
  pending_approvals: number
  invite_email_available: boolean
}

export type PlatformStaff = PlatformSuperAdmin & {
  role_id: number
  role_name: string
  is_super_admin: boolean
  scope: 'all' | 'assigned'
  tenant_ids: number[]
  tenant_names: string[]
  last_sign_in: string | null
  pending_request_id: number | null
}

export type PlatformTeamRole = {
  id: number
  key: string
  name: string
  is_system: boolean
  is_super_admin: boolean
  permissions: Record<string, PlatformAccessLevel>
  staff_count: number
  pending_request_id: number | null
}

export type PlatformApproval = {
  id: number
  action: string
  module: string
  module_label: string
  entity_type: string
  entity_name: string | null
  summary: string
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'failed'
  requested_by: string
  requested_at: string
  decided_by: string | null
  decided_at: string | null
  decision_note: string | null
  result: string | null
  can_decide: boolean
  can_cancel: boolean
}

/** Body of a 202 response when a four-eyes action was queued instead of applied. */
export type PlatformApprovalQueued = { approval_required: true; request_id: number; message: string }

export const isApprovalQueued = (data: unknown): data is PlatformApprovalQueued =>
  !!data && typeof data === 'object' && (data as PlatformApprovalQueued).approval_required === true

export type PlatformAuditEntry = {
  id: number
  action: string
  entity_type: string
  entity_id?: number | null
  entity_name?: string | null
  description?: string | null
  ip_address?: string | null
  performed_by: string
  performed_by_username?: string | null
  old_data?: Record<string, unknown> | null
  new_data?: Record<string, unknown> | null
  created_at: string
}

export type TenantAuditEntry = {
  id: number
  user_id?: number | null
  user_name?: string | null
  module: string
  action: string
  record_id?: number | null
  description?: string | null
  ip_address?: string | null
  created_at: string
}

export type TenantPlanHistoryEntry = {
  id: number
  old_plan_id?: number | null
  old_plan_name?: string | null
  new_plan_id?: number | null
  new_plan_name?: string | null
  changed_by: string
  note?: string | null
  created_at: string
}

export type TenantHealthStatus = {
  status: 'healthy' | 'error'
  db_name: string
  table_count?: number
  error?: string
}

export type SMTPTestResult = {
  success: boolean
  message: string
}

export type PlanDetailsResponse = {
  plan: PlatformPlan
  features: Array<PlatformFeature & { enabled: boolean }>
}

export type TenantFeatureUsage = {
  module: string
  action: string
  usage_count: number
  last_used_at?: string | null
}

export interface PlatformBranding {
  product_name: string
  support_email: string
  logo_url: string
  allow_tenant_branding: boolean
}

export interface PlatformDataCompliance {
  default_region: string
  retention_years: number
  encrypt_documents_at_rest: boolean
}

export interface PlatformChannel {
  key: string
  label: string
  connected: boolean
}

// Databases module (self-hosted MariaDB: cluster = database server, schema = tenant database)
export type DbServerRole = 'Primary' | 'Replica' | 'Standalone' | 'Unknown'
export interface DbServerCard {
  name: string; ip: string; host: string; region: string; reachable: boolean; error: string | null
  version: string | null; role: DbServerRole; role_error: string | null; replica_of: string | null; replica_names: string[]
  lag_seconds: number | null; replication_state: { io_running: string | null; sql_running: string | null; last_error: string | null; source: string | null } | null
  cpu_percent: number | null; memory_percent: number | null; storage_percent: number | null; storage_detail: string | null; metrics_error: string | null
  connections: number | null; max_connections: number | null; connections_percent: number | null; buffer_pool_mb: number | null; latency_ms: number | null
  read_only: boolean | null; log_bin: boolean | null; query_rate_available: boolean
  failover: { visible: boolean; enabled: boolean; reason: string }; tenant_count: number
}
export interface DbTenantPlacement { id: number; name: string; slug: string; status: string; db_name: string; server: string | null; size_mb: number | null; qps: number | null; qps_source: 'performance_schema' | 'platform' | null; connections: number | null; migration_version: string | null }
export interface DbMigration { version: string; description: string; applied: number; total: number; rolled_out: number; status: 'Done' | 'In Progress' | 'Pending' | 'Running'; started_at: string | null }
export interface DbPolicyField { value: string; note: string | null }
export interface DatabasesOverview {
  generated_at: string
  kpis: { clusters: number; total_size_mb: number; server_size_mb: number; connections: number; tenant_connections: number; max_connections: number; replication_configured: boolean; max_replication_lag: number | null; failovers_90d: number; schema_version: string; tenants_behind: number }
  servers: DbServerCard[]
  tenants: DbTenantPlacement[]
  migrations: DbMigration[]
  backup_policy: { snapshots: DbPolicyField; point_in_time: DbPolicyField; cross_region_copy: DbPolicyField; restore_drills: DbPolicyField; last_drill: { passed: boolean; at: string; detail: string } | null }
  capabilities: { move: boolean; move_reason: string; failover_drill: boolean; sql_row_limit: number; sql_timeout_seconds: number }
  sql_examples: string[]
}
export interface DbSqlResult { columns: string[]; rows: (string | number | boolean | null)[][]; row_count: number; truncated: boolean; elapsed_ms: number; row_limit: number; timeout_seconds: number; server: string; replica: boolean; database: string }
export interface DbFailoverDrill { passed: boolean; checks: { server: string; primary: string | null; lag_seconds: number | null; passed: boolean; problems: string[] }[] }
export interface DbServerTest { version: string; role: DbServerRole; tenant_databases: number; grants: string[]; inventory_entry: Record<string, string | number>; already_registered: boolean }
// Monitoring module
export type MonitoringRange = '1h' | '6h' | '24h' | '7d'
export interface MonitoringPoint { minutes_ago: number; rps: number; requests: number; p50: number | null; p95: number | null; p99: number | null; error_rate: number | null }
export interface MonitoringRule { id: number; label: string; metric: string; threshold: number; duration_minutes: number; action: string; action_label: string; target: string | null; severity: string; enabled: boolean; state: 'pending' | 'ok' | 'firing' | 'no_data' | 'unavailable' | 'disabled'; last_value: number | null; last_evaluated_at: string | null; last_fired_at: string | null; reason: string | null; delivery: string | null }
export interface MonitoringIncident { id: number; code: string; title: string; severity: string; status: 'Open' | 'Resolved'; started_at: string; resolved_at: string | null; source: string }
export interface MonitoringOverview {
  service: string; range: MonitoringRange; generated_at: string
  request_metrics: boolean; request_metrics_note: string | null; unit: 'requests' | 'queries'
  kpis: { availability_30d: number | null; availability_tracked_minutes: number; availability_reason: string | null; slo_percent: number; p95_ms: number | null; requests: number | null; error_rate: number | null; error_budget_left: number | null; apdex: number | null; apdex_target_ms: number; saturation: number | null; saturation_server: string | null; saturation_source: 'samples' | 'live' | null }
  series: MonitoringPoint[]
  collecting_since: number | null
  usage:{ label: string; cpu: number | null; memory: number | null; note: string | null }[]
  status: { name: string; status: 'Operational' | 'Degraded' | 'Down' | 'Not configured'; detail: string }[]
  rules: MonitoringRule[]
  incidents: MonitoringIncident[]
  rule_options: { metrics: Record<string, { label: string; unit: string; window: number }>; actions: Record<string, string> }
}
export interface MonitoringRuleCreate { metric: string; threshold: number; duration_minutes: number; action: string; target?: string; severity: string }

// Usage monitoring
export type UsagePeriod = '24h' | '7d' | '30d' | '90d'
export type UsageMeterKey = 'api' | 'dau' | 'rec' | 'em' | 'ai' | 'gb' | 'ocr'
export interface UsageLimit { used: number | null; limit: number | null; remaining: number | null; percent: number | null; source: string }
export interface UsageTenantRow {
  id: number; name: string; slug: string; status: string; plan: string | null; admin_email: string
  available: boolean; error: string | null; measured_at: string | null
  values: Record<UsageMeterKey, number | null>
  api_previous: number; auth_failed_1h: number; api_24h: number; api_prior_7d: number
  limits: { users: UsageLimit; storage: UsageLimit; ai: UsageLimit }
  ratio: number | null; usage_status: 'Healthy' | 'Near limit' | 'Over limit' | null; last_sign_in: string | null
  trend: Record<UsageMeterKey, (number | null)[] | null>
}
export interface UsageMonitoring {
  period: UsagePeriod; generated_at: string; tenants: UsageTenantRow[]; warn_percent: number
  collecting_since: number | null; previous_complete: boolean
  anomalies: { tenant_id: number; kind: 'investigate' | 'notify' | 'files' | 'contact' | 'case'; text: string }[]
  rules: [string, string][]
}

export type StorageTier = 'Hot' | 'Warm' | 'Cold'
export interface StorageFile {
  id: number; name: string; ext: string; root: string; tenant: { id: number; name: string; slug: string }
  size: number; original_size: number; owner: string | null; uploaded_at: string | null; last_accessed_at: string | null
  tier: StorageTier; scan: 'Verified' | 'Quarantined' | 'Released' | 'Infected' | 'Scan error' | 'Not scanned'; scan_detail: string | null; scanned_at: string | null
  quarantined: boolean; quarantine_reason: string | null; quarantined_at: string | null
  links: number; deleted_links: number; refs: string[]; shared: boolean
}
export interface StoragePolicy { key: string; label: string; enabled: boolean; unavailable: string | null; updated_by: string | null; updated_at: string | null; last_run_at: string | null; last_result: string | null; last_error: string | null }
export interface StorageOverview {
  generated_at: string; indexed: boolean; all_scope: boolean
  kpis: {
    total_bytes: number; files: number; growth_30d: number | null; dedup_saved_bytes: number; dedup_percent: number | null; dedup_potential_bytes: number
    quarantined: number; orphaned: number | null; orphaned_bytes: number; cold_percent: number | null; cold_bytes: number; scanned_percent: number | null; trend_mb: number[]
  }
  by_tenant: { tenant_id: number; name: string; slug: string; bytes: number }[]
  by_type: { type: string; bytes: number }[]
  by_tier: { tier: StorageTier; bytes: number; files: number }[]
  files: StorageFile[]; files_total: number; quarantine: StorageFile[]; policies: StoragePolicy[]
  scanner: { available: boolean; name: string | null; error: string | null }
  cold_storage: { configured: boolean; path: string | null; error: string | null }
  jobs: { running: boolean; indexed_at: string | null; index_error: string | null; references_at: string | null; references_result: string | null; references_error: string | null; access_tracking_since: string | null }
}
export interface StorageBulkResult { results: { id: number; ok: boolean; error?: string }[]; done: number; failed: number; notices: string[] }

export interface DbRestoreDrill { passed: boolean; error?: string; expected_tables?: number; restored_tables?: number; seconds?: number; backup_id: number; tenant: string | null; description: string }

//ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ API Client ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬

// KPI drill-down (GET /platform/kpi/{key}): one payload per KPI card popup.
export type KpiColumnKind = 'text' | 'num' | 'inr' | 'pct' | 'date' | 'datetime' | 'pill' | 'mb' | 'bytes' | 'ms' | 'bool' | 'code'
export type KpiQuery = { q?: string; status?: string; tenant_id?: number; date_from?: string; date_to?: string; facet?: string; sort?: string; dir?: 'asc' | 'desc'; page?: number; page_size?: number }
export type KpiDetail = {
  key: string; title: string; description: string | null; note: string | null
  columns: { key: string; label: string; kind: KpiColumnKind; hidden: boolean }[]
  search: boolean; status_filter: boolean; date_filter: boolean; tenant_filter: boolean; group: string | null; group_label: string | null; group_kind: KpiColumnKind | null; amount_label: string | null; amount_kind: KpiColumnKind | null
  sort: string | null; desc: boolean; link: string | null; page: number; page_size: number; total: number
  rows: Record<string, any>[]; summary: { label: string; value: any; kind: KpiColumnKind }[]
  breakdown: { key: string; count: number; amount: number | null }[]; statuses: string[]; tenants: { id: number; name: string }[]
}

export const platformApi = {
  kpiDetail: (key: string, params: KpiQuery) => platformApiClient.get<KpiDetail>(`/platform/kpi/${encodeURIComponent(key)}`, { params }),
  kpiExport: (key: string, params: KpiQuery) => platformApiClient.get<Blob>(`/platform/kpi/${encodeURIComponent(key)}`, { params: { ...params, format: 'csv' }, responseType: 'blob', timeout: 120000 }),
  getSessionTimeout: () => platformApiClient.get<{ timeout_minutes: number }>('/platform/settings/session-timeout'),
  setSessionTimeout: (timeout_minutes: number) => platformApiClient.put<{ timeout_minutes: number }>('/platform/settings/session-timeout', { timeout_minutes }),
  sessionActivity: () => platformApiClient.post<{ timeout_minutes: number }>('/platform/session/activity'),
  loginOptions: () => platformApiClient.get<PlatformLoginOptions>('/platform/login-options'),
  setLoginSecurity: (data: { otp_mode?: PlatformOtpMode; captcha_mode?: PlatformCaptchaMode }) =>
    platformApiClient.put<{ otp_mode: PlatformOtpMode; captcha_mode: PlatformCaptchaMode }>('/platform/settings/login-security', data),
  setLoginControl: (control: 'force_first_login' | 'new_device_alert', enabled: boolean) => platformApiClient.put<{ enabled: boolean }>(`/platform/settings/login-control/${control}`, { enabled }),
  setForgotPassword: (enabled: boolean) => platformApiClient.put<{ forgot_password_enabled: boolean }>('/platform/settings/forgot-password', { enabled }),
  getBranding: () => platformApiClient.get<PlatformBranding>('/platform/settings/branding'),
  updateBranding: (data: { product_name: string; support_email: string | null; allow_tenant_branding: boolean }) =>
    platformApiClient.put<PlatformBranding>('/platform/settings/branding', data),
  uploadBrandingLogo: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return platformApiClient.post<PlatformBranding>('/platform/settings/branding/logo', form, { headers: { 'Content-Type': 'multipart/form-data' } })
  },
  deleteBrandingLogo: () => platformApiClient.delete<PlatformBranding>('/platform/settings/branding/logo'),
  getDataCompliance: () => platformApiClient.get<PlatformDataCompliance>('/platform/settings/data-compliance'),
  updateDataCompliance: (data: PlatformDataCompliance) => platformApiClient.put<PlatformDataCompliance>('/platform/settings/data-compliance', data),
  getChannels: () => platformApiClient.get<PlatformChannel[]>('/platform/settings/channels'),
  systemStatus: () => platformApiClient.get<{ operational: boolean }>('/platform/system-status'),
  requestPasswordReset: () => platformApiClient.post('/platform/request-password-reset'),
  accountActivity: () => platformApiClient.get<{ self_logout_count: number; latest_logout: string | null; last_login: string | null; activity: PlatformAuditEntry[] }>('/platform/account-activity'),
  logout: () => platformApiClient.post('/platform/logout'),
  changePassword: (data: { current_password: string; new_password: string; confirm_password: string }) => platformApiClient.post('/platform/change-password', data),
  me: () => platformApiClient.get<{ full_name: string; username: string; email: string }>('/platform/me'),
  // Auth
  login: (username: string, password: string, deviceId: string, captcha?: { id: string; answer: string }) =>
    platformApiClient.post<PlatformLoginResponse>('/platform/login', {
      username, password, device_id: deviceId,
      captcha_id: captcha?.id, captcha_answer: captcha?.answer,
    }),
  loginCaptcha: () => platformApiClient.post<PlatformCaptcha>('/platform/login/captcha'),
  verifyLoginOtp: (challengeId: string, otp: string, deviceId: string, trustDevice = false) =>
    platformApiClient.post<PlatformLoginResponse>('/platform/login/verify-otp', { challenge_id: challengeId, otp, device_id: deviceId, trust_device: trustDevice }),
  resendLoginOtp: (challengeId: string, deviceId: string) =>
    platformApiClient.post<PlatformLoginResponse>('/platform/login/resend-otp', { challenge_id: challengeId, device_id: deviceId }),
  loginChangePassword: (challengeId: string, newPassword: string, deviceId: string, trustDevice = false) =>
    platformApiClient.post<PlatformLoginResponse>('/platform/login/change-password', { challenge_id: challengeId, new_password: newPassword, device_id: deviceId, trust_device: trustDevice }),
  loginStatus: () => platformApiClient.get<{ operational: boolean; regions: number | null; p95_ms: number | null }>('/platform/login/status'),
  contactAdministrator: (data: { contact: string; category: string; message: string }) =>
    platformApiClient.post<{ reference: string; notified: boolean; message: string }>('/platform/login/contact-administrator', data),

  forgotPassword: (email: string) =>
    platformApiClient.post<{ message: string }>('/platform/forgot-password', { email }),

  resetPassword: (token: string, newPassword: string, confirmPassword: string) =>
    platformApiClient.post<{ message: string }>('/platform/reset-password', {
      token,
      new_password: newPassword,
      confirm_password: confirmPassword,
    }),

  // Config (no auth needed for env banner)
  getConfig: () =>
    platformApiClient.get<PlatformConfig>('/platform/config'),

  getGlobalMaintenance: () =>
    platformApiClient.get<{ enabled: boolean }>('/platform/settings/maintenance'),

  updateGlobalMaintenance: (enabled: boolean) =>
    platformApiClient.put<{ enabled: boolean } | PlatformApprovalQueued>('/platform/settings/maintenance', { enabled }),

  // Stats
  stats: () =>
    platformApiClient.get<PlatformStats>('/platform/stats'),

  // Tenants
  recentDashboardTenants: () => platformApiClient.get<PlatformTenant[]>('/platform/dashboard/recent-tenants'),
  dashboardTenantUsage: () => platformApiClient.get<PlatformDashboardTenantUsage[]>('/platform/dashboard/tenant-usage'),
  dashboardTenantUserCount: () => platformApiClient.get<PlatformDashboardTenantUserCount>('/platform/dashboard/tenant-user-count'),
  dashboardInfrastructure: () => platformApiClient.get<PlatformInfrastructure>('/platform/dashboard/infrastructure'),
  dashboardCommandCenter: () => platformApiClient.get<PlatformCommandCenterLive>('/platform/dashboard/command-center'),
  dashboardCommandCenterSummary: () => platformApiClient.get<PlatformCommandCenterSummary>('/platform/dashboard/command-center/summary'),

  // Tenants & Hierarchy
  tenantHierarchy: () => platformApiClient.get<{ tenants: HierarchyTenantRow[]; groups: HierarchyGroupRow[] }>('/platform/tenant-hierarchy'),
  setTenantHierarchy: (id: number, data: { parent_group_id?: number | null; parent_visibility?: ParentVisibility; shared_masters?: boolean; inherit_parent_policies?: boolean; industry?: string | null; color?: string; detach?: boolean }) =>
    platformApiClient.put(`/platform/tenants/${id}/hierarchy`, data),
  createTenantGroup: (data: { name: string; slug?: string; industry?: string | null; color?: string | null; plan_id?: number | null; default_visibility?: ParentVisibility; notes?: string | null }) =>
    platformApiClient.post<{ id: number; slug: string }>('/platform/tenant-groups', data),
  onboardingPipeline: () => platformApiClient.get<OnboardingPipeline>('/platform/tenant-hierarchy/onboarding', { timeout: 120000 }),
  wizardCreateTenant: (data: { name: string; subdomain: string; plan_id: number | null; feature_ids: number[]; admin_name: string; admin_email: string }) =>
    platformApiClient.post<{ id: number; slug: string; db_name: string; status: string }>('/platform/tenant-hierarchy/tenants', data, { timeout: 300000 }),
  recordBlankWorkflow: (tenantId: number) => platformApiClient.post(`/platform/tenants/${tenantId}/onboarding/workflow-blank`),
  inviteTenantAdmin: (tenantId: number) => platformApiClient.post<{ message: string }>(`/platform/tenants/${tenantId}/invite-admin`, undefined, { timeout: 120000 }),
  setBlueprintStep: (key: string, enabled: boolean) => platformApiClient.put<{ key: string; enabled: boolean }>(`/platform/tenant-hierarchy/onboarding/blueprint/${key}`, { enabled }),
  runOnboardingStep: (tenantId: number) => platformApiClient.post<{ step: string | null; kind?: string; message: string }>(`/platform/tenants/${tenantId}/onboarding/next`, undefined, { timeout: 300000 }),
  exportOptions: () => platformApiClient.get<ExportOptions>('/platform/tenant-hierarchy/export-options'),
  listExports: (tenantId: number) => platformApiClient.get<ExportJobRow[]>(`/platform/tenants/${tenantId}/exports`),
  exportEstimate: (tenantId: number, components: string[]) => platformApiClient.get<{ total_bytes: number; tables: number }>(`/platform/tenants/${tenantId}/exports/estimate`, { params: { components: components.join(',') } }),
  startExport: (tenantId: number, data: { components: string[]; format: string; pii: string; encryption: string; delivery: string; link_days: number; pgp_key?: string }) =>
    platformApiClient.post<ExportJobRow>(`/platform/tenants/${tenantId}/exports`, data),
  exportLink: (tenantId: number, jobId: number) => platformApiClient.post<{ url: string; expires_at: string; sha256: string }>(`/platform/tenants/${tenantId}/exports/${jobId}/link`),
  migrationOptions: () => platformApiClient.get<MigrationOptions>('/platform/tenant-hierarchy/migration-options'),
  listMigrations: (tenantId: number) => platformApiClient.get<MigrationRow[]>(`/platform/tenants/${tenantId}/migrations`),
  getMigration: (tenantId: number, id: number) => platformApiClient.get<MigrationRow>(`/platform/tenants/${tenantId}/migrations/${id}`),
  createMigration: (tenantId: number, source: string, files: File[]) => {
    const form = new FormData()
    form.append('source', source)
    files.forEach(f => form.append('files', f))
    return platformApiClient.post<MigrationRow>(`/platform/tenants/${tenantId}/migrations`, form, { headers: { 'Content-Type': undefined }, timeout: 600000 })
  },
  updateMigration: (tenantId: number, id: number, data: { mapping?: MigrationRow['mapping']; rules?: MigrationRow['rules'] }) => platformApiClient.put<MigrationRow>(`/platform/tenants/${tenantId}/migrations/${id}`, data),
  migrationDryRun: (tenantId: number, id: number) => platformApiClient.post<MigrationRow>(`/platform/tenants/${tenantId}/migrations/${id}/dry-run`, undefined, { timeout: 600000 }),
  migrationErrors: (tenantId: number, id: number) => platformApiClient.get(`/platform/tenants/${tenantId}/migrations/${id}/errors.csv`, { responseType: 'blob' }),
  runMigration: (tenantId: number, id: number) => platformApiClient.post<MigrationRow>(`/platform/tenants/${tenantId}/migrations/${id}/run`),
  rollbackMigration: (tenantId: number, id: number) => platformApiClient.post<MigrationRow>(`/platform/tenants/${tenantId}/migrations/${id}/rollback`, undefined, { timeout: 300000 }),
  retryExport: (tenantId: number, jobId: number) => platformApiClient.post<ExportJobRow>(`/platform/tenants/${tenantId}/exports/${jobId}/retry`),
  verifyExport: (tenantId: number, jobId: number) => platformApiClient.post<ExportVerify>(`/platform/tenants/${tenantId}/exports/${jobId}/verify`, undefined, { timeout: 600000 }),
  createConnectorMigration: (tenantId: number, source: string, objects: string[]) => platformApiClient.post<MigrationRow>(`/platform/tenants/${tenantId}/migrations/connector`, { source, objects }),
  pauseMigration: (tenantId: number, id: number) => platformApiClient.post<MigrationRow>(`/platform/tenants/${tenantId}/migrations/${id}/pause`),
  resumeMigration: (tenantId: number, id: number) => platformApiClient.post<MigrationRow>(`/platform/tenants/${tenantId}/migrations/${id}/resume`),
  scheduleMigration: (tenantId: number, id: number, at: string | null) => platformApiClient.post<MigrationRow>(`/platform/tenants/${tenantId}/migrations/${id}/schedule`, { at }),
  logs: (params: { q?: string; f_t?: string; f_lv?: string; f_svc?: string; f_ten?: string; f_msg?: string; before_id?: number; after_id?: number; limit?: number }) =>
    platformApiClient.get<LogsPage>('/platform/logs', { params }),
  jobsOverview: (refresh = false) => platformApiClient.get<JobsOverview>('/platform/jobs', { params: refresh ? { refresh: 1 } : {} }),
  pauseQueue: (name: string) => platformApiClient.post<{ ok: boolean; workers: number }>(`/platform/jobs/queues/${encodeURIComponent(name)}/pause`),
  resumeQueue: (name: string) => platformApiClient.post<{ ok: boolean; workers: number }>(`/platform/jobs/queues/${encodeURIComponent(name)}/resume`),
  retryQueue: (name: string) => platformApiClient.post<{ ok: boolean; retried: number }>(`/platform/jobs/queues/${encodeURIComponent(name)}/retry-failed`),
  runScheduledJob: (key: string) => platformApiClient.post<{ ok: boolean }>(`/platform/jobs/scheduled/${encodeURIComponent(key)}/run`),
  infrastructureOverview: (refresh = false) => platformApiClient.get<InfrastructureOverview>('/platform/infrastructure', { params: refresh ? { refresh: 1 } : {} }),
  // Creating a release waits for the deployment service to validate it (up to 120 s).
  createRelease: (data: { version: string; notes?: string }) => platformApiClient.post<Release>('/platform/infrastructure/releases', data, { timeout: 150000 }),
  promoteRelease: (id: number) => platformApiClient.post<{ ok: boolean; target_percent: number; release: Release }>(`/platform/infrastructure/releases/${id}/promote`),
  rollbackRelease: (id: number) => platformApiClient.post<{ ok: boolean; target_version: string; release: Release }>(`/platform/infrastructure/releases/${id}/rollback`),
  changesOverview: () => platformApiClient.get<ChangesOverview>('/platform/changes'),
  scheduleChange: (data: { description: string; type: string; window: string }) => platformApiClient.post<ChangeRow>('/platform/changes', data),
  rescheduleChange: (id: number, window: string) => platformApiClient.patch<ChangeRow>(`/platform/changes/${id}`, { window }),
  releaseSteps: (id: number) => platformApiClient.get<{ release: Release; steps: ReleaseStep[] }>(`/platform/infrastructure/releases/${id}/steps`),
  entitlements: () => platformApiClient.get<EntitlementsOverview>('/platform/entitlements'),
  entitlementModules: () => platformApiClient.get<EntitlementModule[]>('/platform/entitlements/modules'),
  setPlanModule: (planId: number, key: string, enabled: boolean) => platformApiClient.put<EntitlementResult>(`/platform/entitlements/plans/${planId}/modules/${encodeURIComponent(key)}`, { enabled }, { timeout: 120000 }),
  setFlagRollout: (key: string, rollout_percent: number) => platformApiClient.put<FeatureFlag>(`/platform/entitlements/flags/${encodeURIComponent(key)}`, { rollout_percent }),
  workflowTemplates: () => platformApiClient.get<{ templates: WorkflowTemplate[]; all_scope: boolean }>('/platform/workflow-templates'),
  createWorkflowTemplate: (data: { name: string; stages: Pick<WorkflowStage, 'name' | 'sla_days' | 'gate' | 'owner_role' | 'checklist'>[] }) => platformApiClient.post<{ id: number; name: string }>('/platform/workflow-templates', data),
  workflowTemplateTenants: (offset = 0, limit = 100) => platformApiClient.get<{ items: WorkflowTenantOption[]; total: number; offset: number; limit: number }>('/platform/workflow-templates/tenants', { params: { offset, limit } }),
  pushTemplateToTenant: (templateId: number, tenantId: number) => platformApiClient.post<WorkflowPushResult>(`/platform/workflow-templates/${templateId}/push`, { tenant_id: tenantId }, { timeout: 120000 }),
  securityOverview: () => platformApiClient.get<SecurityOverview>('/platform/security'),
  customerSuccess: () => platformApiClient.get<CsOverview>('/platform/customer-success', { timeout: 120000 }),
  customerSuccessTenants: (q: string, sort: string, offset: number, limit: number) => platformApiClient.get<Paged<CsRow>>('/platform/customer-success/tenants', { params: { q, sort, offset, limit }, timeout: 120000 }),
  customerSuccessPlaybook: (key: string, enabled: boolean) => platformApiClient.put<{ key: string; enabled: boolean }>(`/platform/customer-success/playbooks/${key}`, { enabled }),
  customerSuccessRun: () => platformApiClient.post<CsRunResult>('/platform/customer-success/run', {}, { timeout: 300000 }),
  revenue: () => platformApiClient.get<RevenueOverview>('/platform/revenue', { timeout: 60000 }),
  finops: (refresh = false) => platformApiClient.get<FinopsOverview>('/platform/finops', { params: refresh ? { refresh: true } : {}, timeout: 120000 }),
  finopsTenants: (q: string, sort: string, offset: number, limit: number) => platformApiClient.get<FinopsPage>('/platform/finops/tenants', { params: { q, sort, offset, limit }, timeout: 120000 }),
  finopsExport: () => platformApiClient.get<Blob>('/platform/finops/export', { responseType: 'blob', timeout: 120000 }),
  marketplace: () => platformApiClient.get<MarketOverview>('/platform/marketplace'),
  marketplaceApps: (q: string, offset: number, limit: number) => platformApiClient.get<Paged<MarketApp>>('/platform/marketplace/apps', { params: { q, offset, limit } }),
  marketplaceAppAction: (id: number, action: string, reason = '') => platformApiClient.post<{ id: number; status: string }>(`/platform/marketplace/apps/${id}/${action}`, { reason }),
  marketplacePolicy: (key: string, enabled: boolean) => platformApiClient.put<{ key: string; enabled: boolean }>(`/platform/marketplace/policy/${key}`, { enabled }),
  mobile: () => platformApiClient.get<MobileOverview>('/platform/mobile', { timeout: 60000 }),
  mobileDevices: (q: string, offset: number, limit: number) => platformApiClient.get<Paged<MobileDevice>>('/platform/mobile/devices', { params: { q, offset, limit } }),
  mobileDeviceAction: (id: number, action: string, confirm = false) => platformApiClient.post<{ status: string; effects: Record<string, number> }>(`/platform/mobile/devices/${id}/${action}`, { confirm }, { timeout: 60000 }),
  mobileBulk: (ids: number[], action: string, confirm = false) => platformApiClient.post<{ done: number[]; skipped: { id: number; reason: string }[] }>('/platform/mobile/devices/bulk', { ids, action, confirm }, { timeout: 120000 }),
  mobileTenant: (id: number, changes: Record<string, unknown>) => platformApiClient.put<MobileTenant>(`/platform/mobile/tenants/${id}`, { changes }),
  mobileAllTenants: (enabled: boolean) => platformApiClient.post<{ enabled: boolean; tenants: number }>('/platform/mobile/tenants/all', { enabled, confirm: true }),
  mobileRelease: (data: { version: string; platform: string; channel: string; rollout: number; notes: string }) => platformApiClient.post<MobileRelease>('/platform/mobile/releases', data),
  mobileReleaseAction: (id: number, action: string, confirm = false) => platformApiClient.post<{ message: string }>(`/platform/mobile/releases/${id}/${action}`, { confirm }),
  mobileMinSupported: (platform: string, version: string) => platformApiClient.put<Record<string, string | null>>('/platform/mobile/min-supported', { platform, version }),
  mobileSoftPrompt: (enabled: boolean) => platformApiClient.put('/platform/mobile/soft-prompt', { enabled }),
  mobilePolicy: (key: string, value: boolean | number) => platformApiClient.put('/platform/mobile/policy/' + key, { value }),
  mobilePushes: () => platformApiClient.get<MobilePush[]>('/platform/mobile/pushes'),
  mobileProviders: () => platformApiClient.get<MobileProvider[]>('/platform/mobile/providers', { timeout: 60000 }),
  mobileSendPush: (data: { audience: string; when: string; title: string; message: string }) => platformApiClient.post<MobilePush>('/platform/mobile/pushes', data, { timeout: 120000 }),
  resellers: () => platformApiClient.get<ResellersOverview>('/platform/resellers'),
  createReseller: (data: { name: string; region: string; commission: number }) => platformApiClient.post<{ id: number; name: string; domain: string }>('/platform/resellers', data),
  setResellerCommission: (id: number, commission: number) => platformApiClient.put<{ id: number; commission: number }>(`/platform/resellers/${id}/commission`, { commission }),
  assignResellerTenant: (id: number, tenantId: number) => platformApiClient.post<{ reseller: string; tenant: string }>(`/platform/resellers/${id}/tenants`, { tenant_id: tenantId }),
  apiWebhooks: () => platformApiClient.get<ApiWebhooksOverview>('/platform/api-webhooks'),
  webhookDeliveries: (offset = 0) => platformApiClient.get<Paged<WebhookDelivery>>('/platform/api-webhooks/deliveries', { params: { offset } }),
  createApiKey: (data: { tenant_id: number; user_id: number; name: string; scopes: string[] }) => platformApiClient.post<CreatedApiKey>('/platform/api-webhooks/keys', data),
  rateLimits: () => platformApiClient.get<RateLimitsOverview>('/platform/api-webhooks/rate-limits'),
  updatePlanRateLimit: (planId: number, data: Partial<Pick<PlanRateLimit, 'per_minute' | 'burst' | 'daily_cap'>>) => platformApiClient.put<{ changed: boolean; plan: PlanRateLimit; applies_within_seconds: number }>(`/platform/api-webhooks/rate-limits/plans/${planId}`, data),
  updateApiVersion: (version: string, data: { status?: string; sunset?: string; clear_sunset?: boolean }) => platformApiClient.put<ApiVersionRow>(`/platform/api-webhooks/versions/${encodeURIComponent(version)}`, data),
  apiKeys: (q: string, status: string, sort: string, offset: number, limit: number) => platformApiClient.get<Paged<ApiKeyRow>>('/platform/api-webhooks/api-keys', { params: { q, status, sort, offset, limit } }),
  rotateApiKey: (id: number) => platformApiClient.post<{ key: string; new: ApiKeyRow; old: ApiKeyRow; overlap_hours: number; note: string }>(`/platform/api-webhooks/api-keys/${id}/rotate`),
  revokeApiKey: (id: number, reason: string) => platformApiClient.post<ApiKeyRow>(`/platform/api-webhooks/api-keys/${id}/revoke`, { confirm: true, reason }),
  supportOverview: () => platformApiClient.get<SupportOverview>('/platform/support'),
  supportTicket: (id: number) => platformApiClient.get<TicketDetail>(`/platform/support/tickets/${id}`),
  supportReply: (id: number, body: string, resolve = false) => platformApiClient.post<{ id: number; email: string | null; resolved: { email: string; rating_link: boolean } | null; ticket: TicketDetail }>(`/platform/support/tickets/${id}/replies`, { body, resolve }, { timeout: 60000 }),
  supportResolve: (id: number) => platformApiClient.post<{ email: string; rating_link: boolean; ticket: TicketDetail }>(`/platform/support/tickets/${id}/resolve`, {}, { timeout: 60000 }),
  supportReopen: (id: number) => platformApiClient.post<{ ticket: TicketDetail }>(`/platform/support/tickets/${id}/reopen`, {}),
  sla: () => platformApiClient.get<SlaOverview>('/platform/sla'),
  slaUpdatePolicy: (planId: number, data: Partial<Pick<SlaPolicy, 'first_response_h' | 'resolution_h' | 'coverage' | 'channels'>>) => platformApiClient.put<{ changed: boolean; version: number | null; policy: SlaPolicy }>(`/platform/sla/policies/${planId}`, data),
  slaUpdateCalendar: (data: Pick<SlaCalendar, 'days' | 'day_start' | 'day_end' | 'holidays'>) => platformApiClient.put<SlaCalendar>('/platform/sla/calendar', data),
  cannedResponses: () => platformApiClient.get<CannedResponse[]>('/platform/sla/canned-responses'),
  supportTickets: (offset = 0) => platformApiClient.get<Paged<SupportTicket>>('/platform/support/tickets', { params: { offset } }),
  addons: () => platformApiClient.get<AddonsOverview>('/platform/addons', { timeout: 60000 }),
  createAddon: () => platformApiClient.post<{ id: number; name: string; status: string }>('/platform/addons'),
  updateAddon: (id: number, data: { name?: string; price?: number }) => platformApiClient.patch<AddonRow>(`/platform/addons/${id}`, data),
  setAddonStatus: (id: number, status: 'Active' | 'Beta' | 'Paused') => platformApiClient.post<{ id: number; status: string }>(`/platform/addons/${id}/status`, { status }),
  tenantAddons: (tenantId: number) => platformApiClient.get<TenantAddon[]>(`/platform/addons/tenants/${tenantId}`),
  setTenantAddon: (tenantId: number, addonId: number, active: boolean, quantity = 1) => platformApiClient.put<TenantAddon[]>(`/platform/addons/tenants/${tenantId}/${addonId}`, { active, quantity }),
  setUsageRate: (data: { plan_id: number; metric: string; included?: number; price?: number }) => platformApiClient.put<{ included: string | null; price: string | null; effective_from: string }>('/platform/addons/usage-rates', data),
  updateTrials: (values: Record<string, unknown>) => platformApiClient.put<TrialSettings>('/platform/addons/trials', { values }),
  extendTrial: (tenantId: number, days: number) => platformApiClient.post<{ trial_ends_at: string }>(`/platform/addons/trials/${tenantId}/extend`, { days }),
  setFxRate: (currency: string, rate: number, effective_from: string) => platformApiClient.put<PriceBooks>(`/platform/addons/price-books/${currency}`, { rate, effective_from }),
  invoicing: () => platformApiClient.get<InvoicingOverview>('/platform/invoicing', { timeout: 60000 }),
  invoicingInvoices: (params: InvoiceListQuery) => platformApiClient.get<Paged<InvoiceRow>>('/platform/invoicing/invoices', { params }),
  invoicingRemind: (id: number) => platformApiClient.post<{ status: string; recipient: string; detail: string }>(`/platform/invoicing/invoices/${id}/remind`, undefined, { timeout: 60000 }),
  invoicingMarkPaid: (id: number, data: { amount: number; gateway: string; reference: string; paid_on: string; evidence: string; confirm: boolean }) =>
    platformApiClient.post<{ status: InvoiceStatus; balance: number }>(`/platform/invoicing/invoices/${id}/payments`, data),
  creditNotes: (offset = 0, limit = 25) => platformApiClient.get<Paged<CreditNoteRow>>('/platform/invoicing/credit-notes', { params: { offset, limit } }),
  creditableInvoices: (q = '') => platformApiClient.get<CreditableInvoice[]>('/platform/invoicing/credit-notes/invoices', { params: { q } }),
  issueCreditNote: (data: { invoice_id: number; amount: number; reason: string }) =>
    platformApiClient.post<{ number: string; invoice_status: InvoiceStatus; balance: number; refund_due: number }>('/platform/invoicing/credit-notes', data),
  updateInvoicingSetting: (key: 'dunning_steps' | 'dunning_policy' | 'gst' | 'einvoice' | 'gateways', values: Record<string, unknown>) =>
    platformApiClient.put<Record<string, unknown>>(`/platform/invoicing/settings/${key}`, { values }),
  verifyGateway: (key: GatewayKey) => platformApiClient.post<GatewayCard>(`/platform/invoicing/gateways/${key}/verify`, undefined, { timeout: 60000 }),
  discounts: (offset = 0, q = '') => platformApiClient.get<DiscountsOverview>('/platform/discounts', { params: { offset, q: q || undefined }, timeout: 60000 }),
  createCoupon: (data: { code: string; kind: string; value: number; duration: string; plan_ids: number[] | null; limit: number; valid_until: string; note: string }) =>
    platformApiClient.post<{ id: number; code: string }>('/platform/discounts/coupons', data),
  toggleCoupon: (id: number) => platformApiClient.post<{ status: string }>(`/platform/discounts/coupons/${id}/toggle`),
  extendCoupon: (id: number) => platformApiClient.post<{ valid_until: string; status: string }>(`/platform/discounts/coupons/${id}/extend`),
  deleteCoupon: (id: number) => platformApiClient.delete<{ deleted: number }>(`/platform/discounts/coupons/${id}`),
  redeemCoupon: (code: string, tenantId: number) => platformApiClient.post<{ id: number; code: string }>('/platform/discounts/coupons/redeem', { code, tenant_id: tenantId }),
  updateVolumeTier: (id: number, pct: number) => platformApiClient.put<{ id: number; pct: number }>(`/platform/discounts/volume-tiers/${id}`, { pct }),
  updateDiscountSetting: (key: string, value: number | boolean) => platformApiClient.put<{ key: string; value: number | boolean }>('/platform/discounts/settings', { key, value }),
  createNegotiatedDiscount: (data: { tenant_id: number; pct: number; term: number; reason: string }) =>
    platformApiClient.post<{ id: number; status: string }>('/platform/discounts/tenant-discounts', data),
  decideNegotiatedDiscount: (id: number, action: 'approve' | 'reject' | 'end') => platformApiClient.post<{ id: number; status: string }>(`/platform/discounts/tenant-discounts/${id}/${action}`),
  updateResellerTier: (tier: string, data: { margin?: number; min_arr?: number }) => platformApiClient.put<{ tier: string; margin: number; min_arr: number }>(`/platform/discounts/reseller-tiers/${tier}`, data),
  tenantDiscounts: (tenantId: number) => platformApiClient.get<TenantDiscounts>(`/platform/discounts/tenants/${tenantId}`),
  regions: () => platformApiClient.get<RegionsOverview>('/platform/regions', { timeout: 60000 }),
  addRegion: () => platformApiClient.post<{ region: string; status: string }>('/platform/regions'),
  regionFailoverTest: (name: string) => platformApiClient.post<FailoverTestResult>(`/platform/regions/${encodeURIComponent(name)}/failover-test`, undefined, { timeout: 120000 }),
  environments: (offset = 0, csOffset = 0, limit = 25) => platformApiClient.get<EnvironmentsOverview>('/platform/environments', { params: { offset, limit, cs_offset: csOffset, cs_limit: limit } }),
  createSandbox: (data: { tenant_id: number; name: string; source: SandboxSource; days: number; confirm_unmasked?: boolean }) =>
    platformApiClient.post<{ id: number; status: string; database: string }>('/platform/environments', data),
  refreshSandbox: (id: number) => platformApiClient.post<{ id: number; status: string }>(`/platform/environments/${id}/refresh`),
  extendSandbox: (id: number) => platformApiClient.post<{ id: number; expires_at: string }>(`/platform/environments/${id}/extend`),
  deleteSandbox: (id: number) => platformApiClient.delete<{ deleted: number }>(`/platform/environments/${id}`),
  promoteChangeSet: (id: number) =>
    platformApiClient.post<{ approval_required: boolean; request_id?: number; promoted?: number; rollback_point?: string }>(`/platform/environments/change-sets/${id}/promote`, undefined, { timeout: 300000 }),
  announcements: (offset = 0, limit = 20) => platformApiClient.get<AnnouncementsOverview>('/platform/announcements', { params: { offset, limit } }),
  publishAnnouncement: (data: { title: string; message: string; type: AnnouncementType; until: string; audience: string }) =>
    platformApiClient.post<{ id: number; audience: string; tenants: number; recipients: number; failed: { tenant: string; error: string }[] }>('/platform/announcements', data, { timeout: 120000 }),
  deleteAnnouncement: (id: number) => platformApiClient.delete<{ deleted: number }>(`/platform/announcements/${id}`),
  scheduleMaintenance: (data: { title: string; date: string; window: string; scope: string; notify: boolean }) =>
    platformApiClient.post<{ id: number; code: string; status: string; approval_required: boolean; notice_id: number | null; warning: string | null }>('/platform/announcements/maintenance', data, { timeout: 120000 }),
  broadcastAnnouncement: (data: { audience: string; title: string; message: string }) => platformApiClient.post<Announcement>('/platform/support/announcements', data, { timeout: 120000 }),
  auditTrail: (params: AuditTrailQuery) => platformApiClient.get<Paged<AuditTrailRow>>('/platform/audit-logs/trail', { params }),
  auditEntry: (id: number) => platformApiClient.get<AuditTrailEntry>(`/platform/audit-logs/${id}`),
  auditExport: (params: Omit<AuditTrailQuery, 'offset' | 'limit'>) => platformApiClient.get<Blob>('/platform/audit-logs/export', { params, responseType: 'blob', timeout: 120000 }),
  tsOverview: () => platformApiClient.get<TsOverview>('/platform/trust-safety', { timeout: 60000 }),
  tsCases: (status: string, offset = 0) => platformApiClient.get<Paged<TsCase>>('/platform/trust-safety/cases', { params: { status, offset } }),
  tsReport: (data: { tenant_id: number | null; title: string; category: string; severity: string; source: string; evidence: string }) => platformApiClient.post<TsCaseDetail>('/platform/trust-safety/cases', data),
  tsCase: (id: number) => platformApiClient.get<TsCaseDetail>(`/platform/trust-safety/cases/${id}`),
  tsCaseAction: (id: number, action: string, note = '') => platformApiClient.post<{ message: string; case: TsCaseDetail }>(`/platform/trust-safety/cases/${id}/actions/${action}`, { note }, { timeout: 60000 }),
  tsSetPolicy: (key: string, enabled: boolean) => platformApiClient.put<TsPolicy[]>(`/platform/trust-safety/policies/${key}`, { enabled }),
  tsUsers: (q: string, offset = 0, tenantId?: number, limit = 25) => platformApiClient.get<Paged<TsUser> & { suspended: number; unreachable: string[] }>('/platform/trust-safety/users', { params: { q, offset, limit, tenant_id: tenantId }, timeout: 60000 }),
  tsUserAction: (tenantId: number, userId: number, action: 'suspend' | 'reinstate' | 'restore') => platformApiClient.post<{ name: string; email: string }>(`/platform/trust-safety/tenants/${tenantId}/users/${userId}/${action}`),
  tsTerminateUser: (tenantId: number, userId: number, data: { reason: string; case_id: number | null; notes: string; transfer_to: number | null; revoke: boolean; notify: boolean; block: boolean; legal_hold: boolean; confirm: string }) =>
    platformApiClient.post<TsTerminateResult>(`/platform/trust-safety/tenants/${tenantId}/users/${userId}/terminate`, data, { timeout: 60000 }),
  tsHistory: (offset = 0) => platformApiClient.get<Paged<TsHistory>>('/platform/trust-safety/history', { params: { offset } }),
  tsEnforceTenant: (tenantId: number, data: { action: 'suspend' | 'terminate'; reason: string; case_id: number | null; confirm: string }) =>
    platformApiClient.post<{ action?: string; message: string; approval_required?: boolean; request_id?: number }>(`/platform/trust-safety/tenants/${tenantId}/enforce`, data),
  billingOverview: () => platformApiClient.get<BillingOverview>('/platform/billing'),
  billingRunPreview: () => platformApiClient.get<{ items: BillingRunItem[]; config: BillingConfig; date: string }>('/platform/billing/run/preview', { timeout: 120000 }),
  billingRun: () => platformApiClient.post<{ created: number; invoices: string[] }>('/platform/billing/run', undefined, { timeout: 120000 }),
  billingInvoice: (id: number) => platformApiClient.get<BillingInvoiceRow & { tax_rate: number; created_by: string | null; billing_email: string | null; lines: BillingInvoiceLine[] }>(`/platform/billing/invoices/${id}`),
  billingRecordPayment: (id: number, paid_on: string, reference: string, evidence: string) => platformApiClient.post<{ ok: boolean }>(`/platform/billing/invoices/${id}/payment`, { paid_on, reference, evidence }),
  dataTransferOverview: () => platformApiClient.get<DataTransferOverview>('/platform/data-transfer'),
  saveConnector: (source: string, config: Record<string, string>) => platformApiClient.put<MigrationConnector>(`/platform/data-transfer/connectors/${encodeURIComponent(source)}`, { config }, { timeout: 120000 }),
  testConnector: (source: string) => platformApiClient.post<MigrationConnector>(`/platform/data-transfer/connectors/${encodeURIComponent(source)}/test`, undefined, { timeout: 120000 }),
  removeConnector: (source: string) => platformApiClient.delete<MigrationConnector>(`/platform/data-transfer/connectors/${encodeURIComponent(source)}`),
  controlSchema: () => platformApiClient.get<{ categories: ControlCategory[]; statuses: Record<ControlStatus, string> }>('/platform/settings/control/schema'),
  controlValues: (tenantId?: number | null) => platformApiClient.get<ControlValues>('/platform/settings/control/values', { params: tenantId ? { tenant_id: tenantId } : {} }),
  setControl: (key: string, value: ControlValue, tenantId?: number | null) => platformApiClient.put<ControlValues>(`/platform/settings/control/values/${key}`, { value, tenant_id: tenantId || null }),
  resetControls: (keys: string[], tenantId?: number | null) => platformApiClient.post<ControlValues>('/platform/settings/control/reset', { keys, tenant_id: tenantId || null }),
  exportControls: (tenantId?: number | null) => platformApiClient.get('/platform/settings/control/export', { params: tenantId ? { tenant_id: tenantId } : {}, responseType: 'blob' }),
  hierarchyServers: () => platformApiClient.get<HierarchyServer[]>('/platform/tenant-hierarchy/servers'),
  tenantWorkflowTemplates: (id: number) => platformApiClient.get<WorkflowRuleTemplate[]>(`/platform/tenants/${id}/workflow-templates`),
  pushWorkflowTemplate: (sourceTenantId: number, tenantIds: number[]) =>
    platformApiClient.post<{ results: { tenant_id: number; tenant: string; copied: string[]; skipped: string[]; error?: string }[] }>('/platform/tenant-hierarchy/push-workflow', { source_tenant_id: sourceTenantId, tenant_ids: tenantIds }, { timeout: 300000 }),
  sendAnnouncement: (tenantIds: number[], title: string, message: string) =>
    platformApiClient.post<{ results: { tenant_id: number; tenant: string; recipients: number; error?: string }[] }>('/platform/tenant-hierarchy/announce', { tenant_ids: tenantIds, title, message }),
  getTenantGroup: (id: number) => platformApiClient.get<TenantGroupDetail>(`/platform/tenant-groups/${id}`),
  updateTenantGroup: (id: number, data: Record<string, unknown>) => platformApiClient.put(`/platform/tenant-groups/${id}`, data),
  suspendTenantGroup: (id: number) => platformApiClient.post(`/platform/tenant-groups/${id}/suspend`),
  reactivateTenantGroup: (id: number) => platformApiClient.post(`/platform/tenant-groups/${id}/reactivate`),
  deleteTenantGroup: (id: number, confirmName: string) => platformApiClient.delete(`/platform/tenant-groups/${id}`, { data: { confirm_name: confirmName } }),
  tenantGroupReport: (id: number) => platformApiClient.get<TenantGroupReport>(`/platform/tenant-groups/${id}/report`),
  tenantGroupUsers: (id: number) => platformApiClient.get<{ users: TenantUserRow[]; hidden_companies: { id: number; name: string; visibility: ParentVisibility }[] }>(`/platform/tenant-groups/${id}/users`),
  tenantGroupAudit: (id: number) => platformApiClient.get<PlatformAuditRow[]>(`/platform/tenant-groups/${id}/audit`),
  tenantOverview: (id: number) => platformApiClient.get<TenantOverview>(`/platform/tenants/${id}/overview`),
  tenantSettingsOverrides: (id: number) => platformApiClient.get<TenantSettingsOverrides>(`/platform/tenants/${id}/settings-overrides`),
  tenantDatabase: (id: number) => platformApiClient.get<TenantDatabase>(`/platform/tenants/${id}/database`),
  tenantDatabaseMaintenance: (id: number, action: 'analyze' | 'optimize' | 'schema_sync') =>
    platformApiClient.post<{ action: string; message: string; errors?: string[]; tables?: string[] }>(`/platform/tenants/${id}/database/maintenance`, { action }, { timeout: 600000 }),
  tenantDatabaseQuery: (id: number, sql: string) => platformApiClient.post<TenantQueryResult>(`/platform/tenants/${id}/database/query`, { sql }),
  tenantSlowQueries: (id: number) => platformApiClient.get<{ available: boolean; reason: string | null; queries: { started_at: string; duration: string; rows_examined: number; rows_sent: number; sql: string }[] }>(`/platform/backups/tenants/${id}/slow-queries`),
  tenantMonitoring: (id: number) => platformApiClient.get<TenantMonitoring>(`/platform/tenants/${id}/monitoring`),
  tenantBackups: (id: number) => platformApiClient.get<TenantBackupRow[]>(`/platform/tenants/${id}/backups`),
  restoreBackup: (backupId: number) => platformApiClient.post<{ database: string; message: string }>(`/platform/backups/${backupId}/restore`, undefined, { timeout: 600000 }),
  downloadBackup: (backupId: number) => platformApiClient.get(`/platform/backups/${backupId}/download`, { responseType: 'blob' }),
  tenantUsers: (id: number) => platformApiClient.get<TenantUserRow[]>(`/platform/tenants/${id}/users`),
  setTenantUserStatus: (id: number, userId: number, isActive: boolean) => platformApiClient.post(`/platform/tenants/${id}/users/${userId}/status`, { is_active: isActive }),
  signOutTenantUser: (id: number, userId: number) => platformApiClient.post<{ revoked_sessions: number }>(`/platform/tenants/${id}/users/${userId}/sign-out`),
  tenantSecurity: (id: number) => platformApiClient.get<TenantSecurity>(`/platform/tenants/${id}/security`),
  updateTenantSecurity: (id: number, data: Partial<TenantSecurity>) => platformApiClient.put<TenantSecurity>(`/platform/tenants/${id}/security`, data),
  tenantConfiguration: (id: number) => platformApiClient.get<TenantConfiguration>(`/platform/tenants/${id}/configuration`),
  tenantMetering: (id: number) => platformApiClient.get<{ meters: TenantMeter[] }>(`/platform/tenants/${id}/metering`),
  tenantPlatformAudit: (id: number) => platformApiClient.get<PlatformAuditRow[]>(`/platform/tenants/${id}/platform-audit`),
  scheduleTenantDeletion: (id: number, confirmName: string) => platformApiClient.post<{ status: string; deletion_scheduled_at: string }>(`/platform/tenants/${id}/schedule-deletion`, { confirm_name: confirmName }),
  cancelTenantDeletion: (id: number) => platformApiClient.post(`/platform/tenants/${id}/cancel-deletion`),

  tenantDatabaseHealth: (tenantId: number) => platformApiClient.get<PlatformDatabaseHealth>(`/platform/backups/tenants/${tenantId}/database-health`),
  listBackups: () => platformApiClient.get<PlatformBackup[]>('/platform/backups'),
  usageMonitoring: (period: UsagePeriod, refresh = false) => platformApiClient.get<UsageMonitoring>('/platform/usage-monitoring', { params: { period, refresh } }),
  storageOverview: () => platformApiClient.get<StorageOverview>('/platform/storage'),
  storageBulk: (action: 'cold' | 'quarantine' | 'delete', ids: number[], reason = '') => platformApiClient.post<StorageBulkResult>('/platform/storage/files/bulk', { action, ids, reason }),
  storageRelease: (id: number, note: string) => platformApiClient.post(`/platform/storage/files/${id}/release`, { note }),
  storageDelete: (id: number, reason: string) => platformApiClient.post<{ ok: boolean; notice: string }>(`/platform/storage/files/${id}/delete`, { reason }),
  setStoragePolicy: (key: string, enabled: boolean) => platformApiClient.patch(`/platform/storage/policies/${key}`, { enabled }),
  storageOrphanScan: () => platformApiClient.post<{ started: boolean; queued: boolean }>('/platform/storage/orphan-scan'),
  storageReport: () => platformApiClient.get('/platform/storage/report', { responseType: 'blob', timeout: 120_000 }),
  monitoringOverview: (service: string, range: MonitoringRange) => platformApiClient.get<MonitoringOverview>('/platform/monitoring', { params: { service, range } }),
  createAlertRule: (body: MonitoringRuleCreate) => platformApiClient.post<MonitoringRule>('/platform/monitoring/alert-rules', body),
  toggleAlertRule: (id: number, enabled: boolean) => platformApiClient.patch<MonitoringRule>(`/platform/monitoring/alert-rules/${id}`, { enabled }),
  databasesOverview: () => platformApiClient.get<DatabasesOverview>('/platform/databases'),
  continueDbMigration: (version: string) => platformApiClient.post<{ version: string; status: string }>(`/platform/databases/migrations/${version}/continue`),
  dbFailoverDrill: () => platformApiClient.post<DbFailoverDrill>('/platform/databases/failover-drill'),
  dbFailover: (server: string, confirm: string) => platformApiClient.post<{ promoted: string; demoted: string | null }>(`/platform/databases/servers/${encodeURIComponent(server)}/failover`, { confirm }),
  dbResize: (server: string, body: { max_connections?: number; buffer_pool_mb?: number }) => platformApiClient.post<{ before: { max_connections: number; buffer_pool_mb: number }; after: { max_connections: number; buffer_pool_mb: number } }>(`/platform/databases/servers/${encodeURIComponent(server)}/resize`, body),
  dbTestServer: (body: { name: string; region: string; host: string; port: number; user: string; password: string }) => platformApiClient.post<DbServerTest>('/platform/databases/servers/test', body),
  dbRestoreDrill: () => platformApiClient.post<DbRestoreDrill>('/platform/databases/restore-drill', undefined, { timeout: 600000 }),
  dbRunSql: (tenantId: number, sql: string) => platformApiClient.post<DbSqlResult>(`/platform/databases/tenants/${tenantId}/sql`, { sql }),
  subscriptionSummary: () => platformApiClient.get<PlatformSubscriptionSummary>('/platform/subscriptions/summary'),
  listTenants: () =>
    platformApiClient.get<PlatformTenant[]>('/platform/tenants'),

  getTenant: (id: number) =>
    platformApiClient.get<PlatformTenant>(`/platform/tenants/${id}`),

  previewTenantUsers: (file: File) => {
    const data = new FormData()
    data.append('file', file)
    return platformApiClient.post<{ users: { full_name: string; email: string; username: string; password: string; role: string }[]; errors: { row: number; message: string }[] }>('/platform/tenant-users/preview', data, { headers: { 'Content-Type': undefined } })
  },
  createTenant: (data: Record<string, unknown>) =>
    platformApiClient.post<PlatformTenant>('/platform/tenants', data),

  updateTenant: (id: number, data: Record<string, unknown>) =>
    platformApiClient.put<PlatformTenant>(`/platform/tenants/${id}`, data),

  suspendTenant: (id: number) =>
    platformApiClient.post<{ message: string } | PlatformApprovalQueued>(`/platform/tenants/${id}/suspend`),

  reactivateTenant: (id: number) =>
    platformApiClient.post(`/platform/tenants/${id}/reactivate`),

  forceLogoutTenant: (id: number, reason?: string) =>
    platformApiClient.post(`/platform/tenants/${id}/force-logout`, { reason }),

  testTenantSmtp: (id: number, data: {
    host: string; port: number; user?: string; password?: string;
    use_tls?: boolean; use_ssl?: boolean;
  }) => platformApiClient.post<SMTPTestResult>(`/platform/tenants/${id}/test-smtp`, data),

  getTenantHealth: (id: number) =>
    platformApiClient.get<TenantHealthStatus>(`/platform/tenants/${id}/health`),

  getTenantPlanHistory: (id: number) =>
    platformApiClient.get<TenantPlanHistoryEntry[]>(`/platform/tenants/${id}/plan-history`),

  getTenantAuditLogs: (id: number, limit = 100) =>
    platformApiClient.get<TenantAuditEntry[]>(`/platform/tenants/${id}/audit-logs?limit=${limit}`),

  getTenantStorage: (id: number) =>
    platformApiClient.get<TenantStorageUsage>(`/platform/tenants/${id}/storage`),

  exportTenantData: (id: number) =>
    platformApiClient.get(`/platform/tenants/${id}/export`, { responseType: 'blob' }),

  // Plans
  listPlans: () =>
    platformApiClient.get<PlatformPlan[]>('/platform/plans'),

  createPlan: (data: Record<string, unknown>) =>
    platformApiClient.post<PlatformPlan>('/platform/plans', data),

  // Features
  listFeatures: () =>
    platformApiClient.get<PlatformFeature[]>('/platform/features'),

  listServices: () => platformApiClient.get<PlatformService[]>('/platform/services'),
  createService: (data: { name: string; key: string; module: string; description?: string; parent_id?: number }) =>
    platformApiClient.post<PlatformService>('/platform/services', data),

  updateService: (id: number, data: { name?: string; module?: string; description?: string; is_active?: boolean }) => platformApiClient.patch('/platform/services/' + id, data),
  deleteService: (id: number) => platformApiClient.delete('/platform/services/' + id),
  // Active/Inactive for any catalog item (module or sub-module, linked or not), by key.
  listServiceTenants: (key: string) => platformApiClient.get<{ service_key: string; tenants: Array<{ id: number; name: string; slug: string; subdomain: string; status: string }> }>('/platform/services/' + encodeURIComponent(key) + '/tenants'),
  updateServiceManagement: (key: string, data: { dependencies?: string[]; configuration_status?: 'ready' | 'needs_configuration' | 'not_applicable'; configuration_notes?: string }) =>
    platformApiClient.put('/platform/services/' + encodeURIComponent(key) + '/management', data),
  setServiceStatus: (key: string, isActive: boolean) =>
    platformApiClient.put<{ key: string; is_active: boolean }>('/platform/services/status', { key, is_active: isActive }),
  // Feature keys Tenant Onboarding should hide because the module (or its parent) is inactive.
  getOnboardingVisibility: () =>
    platformApiClient.get<{ hidden_feature_keys: string[]; inactive_keys: string[] }>('/platform/services/onboarding-visibility'),

  createFeature: (data: Record<string, unknown>) =>
    platformApiClient.post<PlatformFeature>('/platform/features', data),

  getPlanFeatures: (planId: number) =>
    platformApiClient.get<{ plan_id: number; feature_ids: number[] }>(`/platform/plans/${planId}/features`),

    getPlanDetails: (planId: number) =>
  platformApiClient.get<PlanDetailsResponse>(`/platform/plans/${planId}/details`),

  updatePlanFeatures: (planId: number, featureIds: number[]) =>
    platformApiClient.put(`/platform/plans/${planId}/features`, { feature_ids: featureIds }),

  getTenantFeatures: (tenantId: number) =>
    platformApiClient.get<TenantFeaturesResponse>(`/platform/tenants/${tenantId}/features`),

  updateTenantFeatures: (tenantId: number, featureIds: number[]) =>
    platformApiClient.put<{ tenant_id: number; feature_ids: number[] }>(
      `/platform/tenants/${tenantId}/features`,
      { feature_ids: featureIds },
    ),

  updatePlan: (planId: number, data: Record<string, unknown>) =>
    platformApiClient.put<PlatformPlan>(`/platform/plans/${planId}`, data),

  deletePlan: (planId: number) =>
    platformApiClient.delete(`/platform/plans/${planId}`),

  getPlanPermissionsPreview: (planId: number) =>
    platformApiClient.get<PlanPermissionsPreview>(`/platform/plans/${planId}/permissions-preview`),

  // Platform Audit Logs
  listAuditLogPage: (params: { page: number; page_size: number; search?: string; entity_type?: string; action?: string; date_from?: string; date_to?: string }) =>
    platformApiClient.get<{ items: PlatformAuditEntry[]; total: number; entity_types: string[]; actions: string[] }>('/platform/audit-logs', { params }),

  listAuditLogs: (params?: { entity_type?: string; action?: string; limit?: number }) =>
    platformApiClient.get<PlatformAuditEntry[]>('/platform/audit-logs', { params }),

  // Super Admins
  listSuperAdmins: () =>
    platformApiClient.get<PlatformSuperAdmin[]>('/platform/super-admins'),

  createSuperAdmin: (data: { username: string; email: string; full_name: string; password: string }) =>
    platformApiClient.post<PlatformSuperAdmin>('/platform/super-admins', data),

  updateSuperAdmin: (id: number, data: { email?: string; full_name?: string; password?: string }) =>
    platformApiClient.put<PlatformSuperAdmin>(`/platform/super-admins/${id}`, data),

  deactivateSuperAdmin: (id: number) =>
    platformApiClient.post(`/platform/super-admins/${id}/deactivate`),

  activateSuperAdmin: (id: number) =>
    platformApiClient.post(`/platform/super-admins/${id}/activate`),

  // Platform team: roles, scopes and four-eyes approvals
  teamMe: () => platformApiClient.get<PlatformTeamMe>('/platform/team/me'),
  listStaff: () => platformApiClient.get<PlatformStaff[]>('/platform/team/staff'),
  inviteStaff: (data: { full_name: string; username: string; email: string; role_id: number; scope: 'all' | 'assigned'; tenant_ids: number[]; password?: string }) =>
    platformApiClient.post<{ id: number; message: string }>('/platform/team/staff', data),
  resendStaffInvite: (id: number) => platformApiClient.post<{ message: string }>(`/platform/team/staff/${id}/resend-invite`),
  updateStaffAccess: (id: number, data: { role_id: number; scope: 'all' | 'assigned'; tenant_ids: number[] }) =>
    platformApiClient.put<{ message: string } | PlatformApprovalQueued>(`/platform/team/staff/${id}/access`, data),
  listTeamRoles: () => platformApiClient.get<{ modules: PlatformModule[]; roles: PlatformTeamRole[] }>('/platform/team/roles'),
  createTeamRole: (data: { name: string; permissions?: Record<string, PlatformAccessLevel> }) =>
    platformApiClient.post<PlatformTeamRole>('/platform/team/roles', data),
  updateTeamRole: (id: number, data: { name?: string; permissions: Record<string, PlatformAccessLevel> }) =>
    platformApiClient.put<PlatformTeamRole | PlatformApprovalQueued>(`/platform/team/roles/${id}`, data),
  deleteTeamRole: (id: number) => platformApiClient.delete(`/platform/team/roles/${id}`),
  listApprovals: (status: 'all' | 'pending' = 'all') =>
    platformApiClient.get<PlatformApproval[]>('/platform/team/approvals', { params: { status } }),
  approveRequest: (id: number, note?: string) =>
    platformApiClient.post<{ status: string; message: string }>(`/platform/team/approvals/${id}/approve`, { note }),
  rejectRequest: (id: number, note?: string) =>
    platformApiClient.post<{ status: string; message: string }>(`/platform/team/approvals/${id}/reject`, { note }),
  cancelRequest: (id: number) => platformApiClient.post<{ message: string }>(`/platform/team/approvals/${id}/cancel`),
  setFourEyes: (enabled: boolean) =>
    platformApiClient.put<{ enabled: boolean } | PlatformApprovalQueued>('/platform/team/four-eyes', { enabled }),


createTenantBackup: (id: number) =>
  platformApiClient.post(`/platform/tenants/${id}/backup`),

getTenantFeatureUsage: (tenantId: number, days = 30) =>
  platformApiClient.get<TenantFeatureUsage[]>(
    `/platform/tenants/${tenantId}/feature-usage?days=${days}`,
  ),

}

export default platformApiClient
