\copy (select id, substr(md5(owner_email),1,12) as usr, kind, created, length(scrubbed) as len from site.bp_shared_logs order by id) to stdout with (format csv, header true)
