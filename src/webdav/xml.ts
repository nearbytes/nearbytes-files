function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function multistatus(responses: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
${responses}
</D:multistatus>`;
}

export function responseHref(
  href: string,
  props: { isCollection: boolean; etag?: string; length?: number; lastModified?: Date },
): string {
  const etagLine =
    props.etag !== undefined ? `<D:getetag>"${escapeXml(props.etag)}"</D:getetag>` : '';
  const lengthLine =
    props.length !== undefined ? `<D:getcontentlength>${props.length}</D:getcontentlength>` : '';
  const modifiedLine =
    props.lastModified !== undefined
      ? `<D:getlastmodified>${props.lastModified.toUTCString()}</D:getlastmodified>`
      : '';
  const resourcetype = props.isCollection
    ? '<D:resourcetype><D:collection/></D:resourcetype>'
    : '<D:resourcetype/>';
  return `<D:response>
<D:href>${escapeXml(href)}</D:href>
<D:propstat>
<D:prop>
${resourcetype}
${etagLine}
${lengthLine}
${modifiedLine}
</D:prop>
<D:status>HTTP/1.1 200 OK</D:status>
</D:propstat>
</D:response>`;
}

export function lockDiscovery(href: string, token: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<D:prop xmlns:D="DAV:">
<D:lockdiscovery>
<D:activelock>
<D:locktype><D:write/></D:locktype>
<D:lockscope><D:exclusive/></D:lockscope>
<D:depth>infinity</D:depth>
<D:timeout>Second-3600</D:timeout>
<D:locktoken><D:href>${escapeXml(token)}</D:href></D:locktoken>
<D:lockroot><D:href>${escapeXml(href)}</D:href></D:lockroot>
</D:activelock>
</D:lockdiscovery>
</D:prop>`;
}
