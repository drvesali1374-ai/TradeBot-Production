'use client'

import { useState } from 'react'

export default function Home() {
  const [mounted] = useState(true)

  if (!mounted) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#1a1a2e]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500 mx-auto mb-4"></div>
          <p className="text-white text-lg">در حال بارگذاری سیستم اتوماسیون هوشمند...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="w-screen h-screen overflow-hidden">
      <iframe
        src="/index.html"
        className="w-full h-full border-0"
        title="سیستم اتوماسیون هوشمند - تحلیل تکنیکال"
        style={{ display: 'block' }}
      />
    </div>
  )
}
