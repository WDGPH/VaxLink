import { faqItems } from '@/content/site'

export function FAQSection() {
  return (
    <div className="faq-grid">
      {faqItems.map((item) => (
        <details key={item.question} className="faq-card">
          <summary>{item.question}</summary>
          <p>{item.answer}</p>
        </details>
      ))}
    </div>
  )
}
