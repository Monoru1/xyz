"use client";

import { useEffect, useState } from "react";
import { formatAmount } from "@/lib/format";

type Service = { id: string; name: string; priceCents: number; durationMinutes: number };
type Slot = { value: string; label: string };

/**
 * L'application ne déclenche jamais de paiement : elle enregistre la demande,
 * puis affiche l'attente de confirmation. Le lien de paiement est envoyé au
 * client par WhatsApp et s'ouvre hors de l'application.
 */
export function BookingForm({ salonId, services }: { salonId: string; services: Service[] }) {
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [date, setDate] = useState("");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slot, setSlot] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState<{ bookingId: string; notified: boolean } | null>(null);

  useEffect(() => {
    if (!serviceId || !date) return;
    fetch(`/api/slots?serviceId=${serviceId}&date=${date}`)
      .then((r) => r.json())
      .then((d) => {
        setSlots(d.slots ?? []);
        setSlot("");
      });
  }, [serviceId, date]);

  async function submit(formData: FormData) {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          salonId,
          serviceId,
          startsAt: slot,
          customerName: formData.get("name"),
          customerEmail: formData.get("email"),
          customerPhone: formData.get("phone"),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "Une erreur est survenue");
        return;
      }
      setSent({ bookingId: data.bookingId, notified: Boolean(data.notified) });
    } catch {
      setError("Connexion impossible. Réessayez.");
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <div className="card">
        <h2>Réservation envoyée — en attente de confirmation</h2>
        <p>
          {sent.notified
            ? "Un lien de confirmation vient de vous être envoyé sur WhatsApp. Ouvrez-le pour finaliser votre rendez-vous."
            : "Votre demande est enregistrée. Le salon vous recontacte pour vous transmettre le lien de confirmation."}
        </p>
        <p>
          <a className="button" href={`/reservation/${sent.bookingId}`}>
            Suivre ma réservation
          </a>
        </p>
      </div>
    );
  }

  return (
    <form action={submit} className="card">
      <h2>Votre rendez-vous</h2>

      <label>Prestation</label>
      <select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
        {services.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} — {formatAmount(s.priceCents)}
          </option>
        ))}
      </select>

      <label>Date</label>
      <input
        type="date"
        min={new Date().toISOString().slice(0, 10)}
        value={date}
        onChange={(e) => setDate(e.target.value)}
        required
      />

      <label>Créneau</label>
      <select value={slot} onChange={(e) => setSlot(e.target.value)} required>
        <option value="">{date ? "Choisir une heure" : "Choisir d’abord une date"}</option>
        {slots.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>

      <label>Nom complet</label>
      <input name="name" minLength={2} required />

      <label>E-mail</label>
      <input name="email" type="email" required />

      {/* Le numéro porte le lien de confirmation : il est obligatoire. */}
      <label>Téléphone WhatsApp</label>
      <input name="phone" type="tel" minLength={6} required placeholder="+229 97 00 00 00" />

      {error && <p className="error">{error}</p>}

      <button className="button" disabled={loading || !slot}>
        {loading ? "Envoi…" : "Envoyer ma réservation"}
      </button>
    </form>
  );
}
