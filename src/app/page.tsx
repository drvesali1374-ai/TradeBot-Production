'use client'

import { useState, useEffect } from 'react'

export default function Home() {
  const [authStatus, setAuthStatus] = useState<'loading' | 'authenticated' | 'unauthenticated'>('loading')

  useEffect(() => {
    // Check if user is authenticated
    fetch('/api/auth/verify', { credentials: 'same-origin' })
      .then(res => {
        if (res.ok) {
          setAuthStatus('authenticated')
        } else {
          setAuthStatus('unauthenticated')
        }
      })
      .catch(() => setAuthStatus('unauthenticated'))
  }, [])

  // Redirect to login if not authenticated
  useEffect(() => {
    if (authStatus === 'unauthenticated') {
      window.location.href = '/login.html'
    }
  }, [authStatus])

  if (authStatus === 'loading') {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#1a1a2e]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500 mx-auto mb-4"></div>
          <p className="text-white text-lg">در حال بارگذاری سیستم اتوماسیون هوشمند...</p>
        </div>
      </div>
    )
  }

  if (authStatus === 'unauthenticated') {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#1a1a2e]">
        <div className="text-center">
          <p className="text-white text-lg">در حال انتقال به صفحه ورود...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="w-screen h-screen overflow-hidden">
      <iframe
        src="/home.html"
        className="w-full h-full border-0"
        title="سیستم اتوماسیون هوشمند - تحلیل تکنیکال"
        style={{ display: 'block' }}
      />
    </div>
  )
}
