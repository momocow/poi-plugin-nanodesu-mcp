import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const main = async () => {
  const client = new Client({ name: 'live-check', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:12450/mcp')))
  const { tools } = await client.listTools()
  console.log('TOOLS:', tools.map((t) => t.name).join(', '))

  const text = (r: unknown) =>
    (r as { content: { text: string }[] }).content.map((c) => c.text).join('')

  const basic = JSON.parse(
    text(await client.callTool({ name: 'poi_get', arguments: { path: 'info.basic' } })),
  )
  console.log('ADMIRAL: lv', basic.value.api_level, '| ships max', basic.value.api_max_chara)

  const res = JSON.parse(
    text(await client.callTool({ name: 'poi_get', arguments: { path: 'info.resources' } })),
  )
  console.log('RESOURCES:', JSON.stringify(res.value))

  const damaged = JSON.parse(
    text(
      await client.callTool({
        name: 'poi_get',
        arguments: {
          path: 'info.ships',
          where: 'api_nowhp < api_maxhp',
          select: ['api_ship_id', 'api_nowhp', 'api_maxhp', 'api_lv'],
        },
      }),
    ),
  )
  console.log(`DAMAGED: ${damaged.returned} of ${damaged.total} ships`)

  const ids = Object.values(damaged.items).map((s: any) => s.api_ship_id).slice(0, 5)
  if (ids.length) {
    const names = JSON.parse(
      text(
        await client.callTool({
          name: 'poi_lookup',
          arguments: { kind: 'ships', ids, select: ['api_name'] },
        }),
      ),
    )
    for (const [id, ship] of Object.entries<any>(damaged.items).slice(0, 5)) {
      const n = names[String(ship.api_ship_id)]?.api_name ?? '?'
      console.log(`  ${n} Lv${ship.api_lv}  ${ship.api_nowhp}/${ship.api_maxhp}`)
    }
  }

  const desc = JSON.parse(
    text(await client.callTool({ name: 'poi_describe', arguments: {} })),
  )
  console.log('ROOTS:', desc.keys.join(', '))
  await client.close()
}
main().catch((e) => { console.error('LIVE CHECK FAILED:', e); process.exit(1) })
