for file in ./out/*
do
    if test -f $file
    then
        ext=${file##*.}
        if [ $ext = 'html' ]
        then
            kindlegen $file
        fi
    fi
done