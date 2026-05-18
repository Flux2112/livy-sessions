import {
  buildNodeManagerLogUrl,
  buildTimelineLogUrl,
  deriveResourceManagerUrl,
  extractDiagnosticsLog,
  extractPlainTextLog,
  resolveContainerIdFromAppInfo,
  resolveContainerIdFromAttempts,
} from '../yarn-logs'

describe('YARN log helpers', () => {
  it('extracts the AM container id from amContainerLogs', () => {
    const containerId = resolveContainerIdFromAppInfo({
      amContainerLogs:
        'https://edge/gateway/yarn/node/containerlogs/container_e65_1778590029506_1484_01_000001/hanke',
    })

    expect(containerId).toBe('container_e65_1778590029506_1484_01_000001')
  })

  it('builds the Knox NodeManager container log URL', () => {
    const url = buildNodeManagerLogUrl({
      gatewayUrl: 'https://edge:8443/gateway/cdp-proxy/yarnuiv2/',
      containerId: 'container_e65_1778590029506_1484_01_000001',
      appUser: 'hanke',
      stream: 'stderr',
      nodeHost: 'anucdp-worker-03.w.oenb.co.at',
      nodePort: 8041,
      start: 0,
    })

    expect(url).toBe(
      'https://edge:8443/gateway/cdp-proxy/yarnuiv2/node/containerlogs/' +
        'container_e65_1778590029506_1484_01_000001/hanke/stderr' +
        '?start=0&scheme=https&host=anucdp-worker-03.w.oenb.co.at&port=8041'
    )
  })

  it('extracts log contents from aggregated log text', () => {
    const text = extractPlainTextLog(`Container: container_e65_x
LogType:stderr
LogLength:12
LogContents:
Traceback line
End of LogType:stderr`)

    expect(text).toBe('Traceback line')
  })

  it('extracts log contents from NodeManager HTML', () => {
    const text = extractPlainTextLog(`
      <html><body><pre>Container: container_e65_x
Log Type: stdout
Log Upload Time: today
Log Length: 18

hello &lt;world&gt;
</pre></body></html>`)

    expect(text).toBe('hello <world>')
  })

  it('derives the kerberized ResourceManager URL from Livy URL', () => {
    const url = deriveResourceManagerUrl(
      'https://edge:8443/gateway/cdp-kerberos-api/livy_for_spark3'
    )

    expect(url).toBe('https://edge:8443/gateway/cdp-kerberos-api/resourcemanager/v1')
  })

  it('extracts stderr tail from ResourceManager diagnostics', () => {
    const diagnostics = `Last 4096 bytes of stderr :
Traceback line


For more detailed output, check the application tracking page: https://example`

    expect(extractDiagnosticsLog(diagnostics)).toBe('Traceback line')
  })

  it('extracts the AM container id from ResourceManager app attempts', () => {
    const containerId = resolveContainerIdFromAttempts({
      appAttempts: {
        appAttempt: [
          {
            id: 1,
            containerId: 'container_e65_1778590029506_1486_01_000001',
            logsLink: 'https://anucdp-worker-03.w.oenb.co.at:8044/node/containerlogs/container_e65_1778590029506_1486_01_000001/hanke',
          },
        ],
      },
    })

    expect(containerId).toBe('container_e65_1778590029506_1486_01_000001')
  })

  it('builds the YARN history timeline log URL', () => {
    const url = buildTimelineLogUrl({
      gatewayUrl: 'https://edge:8443/gateway/cdp-proxy/yarnuiv2/',
      historyHost: 'anucdp-mgmt-03.w.oenb.co.at',
      historyPort: 19890,
      containerId: 'container_e65_1778590029506_1486_01_000001',
      stream: 'stdout',
    })

    expect(url).toBe(
      'https://edge:8443/gateway/cdp-proxy/yarnuiv2/timeline' +
        '?host=anucdp-mgmt-03.w.oenb.co.at&port=19890/ws/v1/history/containerlogs/' +
        'container_e65_1778590029506_1486_01_000001/stdout?manual_redirection=true'
    )
  })
})
