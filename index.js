'use strict'

var cheerio = require('cheerio'),
    parser = require('xml2json'),
    request = require('request'),
    fs = require('fs'),
    path = require('path'),
    escaper = require("true-html-escape"),
    nodemailer = require('nodemailer'),
    smtpTransport = require('nodemailer-smtp-transport'),
    archiver = require('archiver'),
    config = require('./config')

const DIST_PATH = path.resolve(__dirname, './out')

var queue = function(q, opt) {
    opt = opt || {}
    var limit = opt.limit || q.length,
        all = q.length,
        err_stack = [],
        ret = []
    var go = function(q, resolve, reject) {
        var items = q.splice(0, limit)
        Promise.all(items).then(function(re) {
            ret = ret.concat(re)
            if (q.length) {
                go(q, resolve, reject)
            } else {
                resolve({
                    ret,
                    err_stack
                })
            }
        }, function() {
            err_stack.push(items)
            if (q.length) {
                go(q, resolve, reject)
            } else {
                resolve({
                    ret,
                    err_stack
                })
            }
        })
    }
    return new Promise(function(resolve, reject) {
        return go(q, resolve, reject)
    }) 
}

var getRssItem = function(body, keys) {
    keys = keys.split('.')
    var key = keys.shift()
    while(key) {
        body = body[key]
        key = keys.shift()
    }
    return body
}

var fetch = function(opt) {
    return new Promise(function(resolve,reject) {
        request(opt, function(error, response, body) {
            if (error) {
                reject(error)
            } else {
                resolve(body)
            }
        })
    })
}

var parseRss = function(api, formatter) {
    formatter = Object.assign({
        item: 'rss.channel.item',
        title: 'title',
        link: 'link'
    }, formatter)
    return new Promise(function(resolve, reject) {
        request({
            method: 'get',
            url: api
        }, function (error, response, body) {
            if (error) {
                reject(error)
            } else {
                try {
                    body = JSON.parse(parser.toJson(body))
                    body = getRssItem(body, formatter.item)
                    if (body) {
                        resolve(body.map(function(item) {
                            return {
                                title: item[formatter.title],
                                link: item[formatter.link],
                            }
                        }))
                    }
                } catch (err) {
                    reject(err)
                }
            }
        })
    })
}

var parseHtml = function(link, formatter) {
    return new Promise(function(resolve, reject) {
        request({
            url: link
        }, function(error, response, body) {
            if (error) {
                reject(error)
            } else {
                let $ = cheerio.load(body)
                let content = $(formatter.content).map(function() {
                    return $(this).html()
                }).get().join('')
                resolve({
                    title: $(formatter.title).text(),
                    content,
                })
            }
        })
    })
}

var unescapeHtml = function(html) {
    return escaper.unescape(html)
}

var genContent = function(re) {
    var buff = []
    buff.push('<section class="yue">')
    re.forEach(function(item) {
        buff.push(`<article><h2>${item.title}</h2><section>${unescapeHtml(item.content)}</section></article>`)
    })
    buff.push('</section>')
    return buff.join('')
}

// kindle推送对于html要求非常严格
var genFile = function(content) {
    return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd"><html xmlns="http://www.w3.org/1999/xhtml" lang="zh" xml:lang="zh"><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"/><title>Document</title><style>h2{margin-bottom: 2em;}article{margin-bottom: 2em;}img {max-width: 100%;}</style></head><body>${content}</body</body></html>`
}

// 抓取西贝rss
var doCnbeta = function() {
    return parseRss('http://rss.cnbeta.com/rss').then(function(re) {
        return queue(re.map(function(item) {
            return parseHtml(item.link, {
                title: '#news_title',
                content: '.article_content'
            })
        }), {
            limit: 10
        }).then(function(re) {
            return re.ret
        })
    })
}


// 抓取知乎
var doZhihu = function() {
    return parseRss('http://www.zhihu.com/rss', {
        item: 'rss.channel.item',
        link: 'description'
    }).then(function(re) {
        return re.map(function(item) {
            return {
                title: item.title,
                content: item.link
            }
        })
    })
}


// 抓取v2ex
var doV2ex = function() {
    return fetch({
        url: 'https://www.v2ex.com/api/topics/hot.json'
    }).then(function(re) {
        if (re) {
            re = JSON.parse(re)
            return re.map(function(item) {
                return {
                    title: item.title,
                    content: item.content
                }
            })
        }
    })
}

// 抓取煎蛋
var doJiandan = function() {
    return parseRss('http://jandan.net/feed').then(function(re) {
        return queue(re.map(function(item) {
            return parseHtml(item.link, {
                title: 'h1',
                content: '#content .post p'
            })
        }), {
            limit: 10
        }).then(function(re) {
            return re.ret
        })
    })
}

// 抓取简书
var doJianshu = function() {
    return fetch({
        url: 'http://www.jianshu.com/'
    }).then(function(re) {
        if (re) {
            let $ = cheerio.load(re)
            let links = $('h4 a').map(function(i, el) {
                return $(this).attr('href')
            }).get()
            return queue(links.map(function(link) {
                return parseHtml('http://www.jianshu.com' + link, {
                    title: 'h1.title',
                    content: '.show-content'
                })
            }, {
                limit: 10
            }))
        }
    }).then(function(re) {
        return re.ret
    })
}

// 归档
var archive = function(attachments) {
    var outputPath = path.resolve(__dirname, './out/kindle_' + Date.now() + '.zip'),
        outputStream = fs.createWriteStream(outputPath)
        archive = archiver('zip')

    archive.pipe(outputStream)
    attachments.forEach(function (item) {
        archive.append(fs.createReadStream(item), {name: path.basename(item)})
    })
    archive.finalize()
    return new Promise(function(resolve, reject) {
        outputStream.on('close', function() {
            resolve(outputPath)
        })
        archive.on('error', function(error) {
            reject(error)
        })
    })
}

// 遍历文件夹
var walk = function(dir,ext) {
    ext = [].concat(ext)
    return fs.readdirSync(dir).filter(function(filename) {
        return  ext.indexOf(path.extname(filename)) !== -1
    }).map(function(filename) {
        return path.resolve(dir, filename)
    })
}

// 发送邮件
var send = function(attachments) {
    var transport = nodemailer.createTransport(smtpTransport({
        host: 'smtp.' + config.from.split('@')[1],
        debug: true,
        auth: {
            user: config.from,
            pass: config.password
        }
    }))
    return new Promise(function(resolve, reject) {
        transport.sendMail({
            from: config.from,
            to: config.to,
            subject: 'yo', // 空主题会被当做spam
            text: 'yo', // 空内容会被当做spam
            attachments: fs.createReadStream(attachments)
        }, function(err,re) {
            if (err) {
                reject(err)
            } else {
                resolve(re)
            }
        })
    })
}

// 清理目录
var clean = function() {
    walk(DIST_PATH, ['.html','.zip']).forEach(function(file) {
        fs.unlinkSync(file)
    })
}

process.on('uncaughtException', function(err) {
    console.log(err.stack)
})
.on('unhandledRejection', function(err) {
    console.log(err.stack)
})


// 入口
Promise.all([doCnbeta(),doZhihu(),doV2ex(),doJiandan(),doJianshu()]).then(function(res) {
    var filename = ['cnbeta','zhihu','v2ex','jiandan','jianshu']
    if (res) {
        if (!fs.existsSync(DIST_PATH)) {
            fs.mkdirSync(DIST_PATH)
        }
        res.forEach(function(re,index) {
            fs.writeFileSync(`./out/${filename[index]}.html`, genFile(genContent(re)))
        })
        return Promise.resolve()
    }
}).then(function() {
    archive(walk(DIST_PATH, '.html')).then(function(dist) {
        send(dist).then(function(re) {
            console.log('发送成功')
            clean()
        },function(err) {
            console.log('发送失败: ' + err)
        })
    })
})
