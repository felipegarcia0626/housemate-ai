import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Política de privacidad | HouseMate AI",
  description: "Información sobre el tratamiento de datos en HouseMate AI.",
};

export default function PrivacyPage() {
  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">HOUSEMATE AI</p>
          <h1>Política de privacidad</h1>
        </div>
        <Link className="refresh" href="/">
          Volver a la aplicación
        </Link>
      </header>

      <article
        className="panel"
        style={{ display: "grid", gap: "1.25rem", lineHeight: 1.65 }}
      >
        <p>
          Esta política describe, de forma sencilla, cómo HouseMate AI puede
          procesar información cuando utilizas su aplicación web o interactúas
          con el agente mediante WhatsApp.
        </p>

        <section>
          <h2>Información que puede procesarse</h2>
          <ul>
            <li>
              Datos que introduces en la aplicación, como gastos, ingresos,
              montos, fechas, descripciones, comercios, categorías, pagadores y
              reglas de reparto.
            </li>
            <li>
              Mensajes que envías al agente para consultar información o
              proponer una operación financiera.
            </li>
            <li>
              Cuando utilizas WhatsApp, el texto del mensaje, el identificador
              del remitente, el identificador del evento y los metadatos
              necesarios para asociar el mensaje al hogar configurado.
            </li>
            <li>
              Información técnica mínima necesaria para recibir solicitudes y
              entregar respuestas a través de los servicios utilizados por la
              aplicación.
            </li>
          </ul>
        </section>

        <section>
          <h2>Cómo se utiliza la información</h2>
          <p>
            HouseMate AI utiliza estos datos para mostrar tus registros
            financieros, calcular resultados en el backend, interpretar
            consultas del agente, preparar propuestas que requieren
            confirmación explícita y procesar mensajes de WhatsApp. La
            aplicación no crea una operación financiera iniciada por el agente
            antes de la confirmación correspondiente.
          </p>
        </section>

        <section>
          <h2>Proveedores externos</h2>
          <p>
            Para prestar el servicio, algunos datos pueden ser procesados por
            proveedores externos. Supabase/PostgreSQL almacena la información
            financiera del MVP; OpenAI puede procesar los mensajes necesarios
            para interpretar las solicitudes del agente; y WhatsApp/Meta puede
            procesar los mensajes y metadatos que entrega su plataforma. Vercel
            aloja y ejecuta la aplicación. Cada proveedor procesa la
            información conforme a sus propios términos y políticas.
          </p>
        </section>

        <section>
          <h2>Alcance actual del MVP</h2>
          <p>
            HouseMate AI es un MVP. Actualmente no ofrece cuentas de usuario,
            autenticación real ni historial persistente de conversaciones web.
            Esta política no describe funcionalidades que no estén disponibles
            en la aplicación.
          </p>
        </section>

        <section>
          <h2>Conservación y seguridad</h2>
          <p>
            Los registros necesarios para operar el MVP se conservan en el
            almacenamiento configurado para la aplicación mientras sean
            necesarios para prestar el servicio. HouseMate AI aplica controles
            de contexto y separación por hogar en el backend, pero ningún
            sistema conectado a Internet puede garantizar seguridad absoluta.
          </p>
        </section>

        <section>
          <h2>Consultas</h2>
          <p>
            Para realizar una consulta sobre esta política o sobre el uso de la
            aplicación, puedes utilizar el canal público de Issues del
            repositorio del proyecto:{" "}
            <a
              href="https://github.com/felipegarcia0626/housemate-ai/issues"
              target="_blank"
              rel="noreferrer"
            >
              GitHub Issues de HouseMate AI
            </a>
            .
          </p>
        </section>

        <p>
          Esta política puede actualizarse cuando cambien el MVP o sus
          proveedores. La versión publicada en esta página será la vigente.
        </p>
      </article>
    </main>
  );
}
